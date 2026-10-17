import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { z } from 'zod'
import { sha256 } from './deployment-handoff.ts'

const directory = '.local/deploy'
const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error('Missing verification prerequisite')
  return value
}
const aws = (args: string[]): unknown =>
  JSON.parse(
    execFileSync('aws', [...args, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
const text = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value))
const httpsUrl = text.refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
})
const stringOutput = z.object({ value: text })
const outputSchema = z.object({
  web_bucket: stringOutput,
  cloudfront_distribution_id: stringOutput,
  api_lambda_function_name: stringOutput,
  web_url: z.object({ value: httpsUrl }),
  api_url: z.object({ value: httpsUrl }),
  database_driver: stringOutput,
  database_name: stringOutput,
  database_resource_arn: stringOutput,
  database_secret_arn: stringOutput,
})
const outputs = () =>
  outputSchema.parse(JSON.parse(readFileSync(`${directory}/outputs.private.json`, 'utf8')))
type Check = { name: string; status: 'passed' | 'failed'; attempts: number; detail: string }
type Dependencies = {
  aws: (args: string[]) => unknown
  fetch: typeof fetch
  accessTeamDomain: string
  lambdaCodeSha256: string
  wait: () => Promise<unknown>
}
// Only these deliberately safe messages are reported, never provider payloads or arbitrary errors.
class VerificationFailure extends Error {}
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new VerificationFailure(detail)
}

export async function verifyProduction(input: unknown, dependencies: Dependencies) {
  const output = outputSchema.parse(input)
  const checks: Check[] = []
  const check = async (name: string, operation: () => unknown | Promise<unknown>) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await operation()
        checks.push({ name, status: 'passed', attempts: attempt, detail: 'Verified' })
        return
      } catch (error) {
        if (attempt < 3) {
          await dependencies.wait()
          continue
        }
        checks.push({
          name,
          status: 'failed',
          attempts: attempt,
          detail:
            error instanceof VerificationFailure
              ? error.message
              : 'Cloud/HTTPS request or response validation failed; sensitive diagnostics omitted.',
        })
      }
    }
  }
  await check('cloudfront-ready', () => {
    const result = z
      .object({
        Distribution: z.object({
          Status: z.string(),
          DistributionConfig: z.object({ Enabled: z.boolean() }),
        }),
      })
      .parse(
        dependencies.aws([
          'cloudfront',
          'get-distribution',
          '--id',
          output.cloudfront_distribution_id.value,
        ]),
      ).Distribution
    expect(
      result.DistributionConfig.Enabled && result.Status === 'Deployed',
      'CloudFront is not enabled and fully deployed yet.',
    )
  })
  for (const [name, url] of [
    ['web', output.web_url.value],
    ['api', output.api_url.value],
  ]) {
    // HTTPS itself exercises DNS resolution (IPv4 or IPv6) and certificate validation.
    await check(`${name}-https-access`, async () => {
      const response = await dependencies.fetch(url!, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      })
      try {
        if ([401, 403].includes(response.status)) return
        const location = response.headers.get('location')
        const team = new URL(
          dependencies.accessTeamDomain.includes('://')
            ? dependencies.accessTeamDomain
            : `https://${dependencies.accessTeamDomain}`,
        )
        const redirect = location ? new URL(location, url) : null
        expect(
          [301, 302, 303, 307, 308].includes(response.status) &&
            redirect?.protocol === 'https:' &&
            redirect.hostname === team.hostname,
          `Expected access denial or an HTTPS login redirect; received status ${response.status}.`,
        )
      } finally {
        await response.body?.cancel()
      }
    })
  }
  await check('api-gateway-default-endpoint-disabled', () => {
    const domain = new URL(output.api_url.value).hostname
    const mappings = z
      .object({ Items: z.array(z.object({ ApiId: z.string() })).min(1) })
      .parse(dependencies.aws(['apigatewayv2', 'get-api-mappings', '--domain-name', domain]))
    for (const id of new Set(mappings.Items.map((mapping) => mapping.ApiId))) {
      const api = z
        .object({ DisableExecuteApiEndpoint: z.boolean() })
        .parse(dependencies.aws(['apigatewayv2', 'get-api', '--api-id', id]))
      expect(
        api.DisableExecuteApiEndpoint,
        'An API mapped to the app domain has its default endpoint enabled.',
      )
    }
  })
  await check('lambda-exact-code', () => {
    const config = z
      .object({ CodeSha256: z.string() })
      .parse(
        dependencies.aws([
          'lambda',
          'get-function-configuration',
          '--function-name',
          output.api_lambda_function_name.value,
        ]),
      )
    expect(
      config.CodeSha256 === dependencies.lambdaCodeSha256,
      'Deployed Lambda code does not match the reviewed build.',
    )
  })
  return { schemaVersion: 1, success: checks.every((check) => check.status === 'passed'), checks }
}

async function main() {
  process.umask(0o077)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.argv[2] === 'outputs') {
    const output = outputs()
    const safeOutputs = {
      web_bucket: output.web_bucket.value,
      distribution_id: output.cloudfront_distribution_id.value,
      lambda_function: output.api_lambda_function_name.value,
      web_url: output.web_url.value,
      api_url: output.api_url.value,
    }
    writeFileSync(
      env('GITHUB_OUTPUT'),
      Object.entries(safeOutputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
      { flag: 'a' },
    )
    console.log(`::add-mask::${output.database_secret_arn.value}`)
    const database = {
      DATABASE_DRIVER: output.database_driver.value,
      DATABASE_NAME: output.database_name.value,
      DATABASE_RESOURCE_ARN: output.database_resource_arn.value,
      DATABASE_SECRET_ARN: output.database_secret_arn.value,
    }
    writeFileSync(
      env('GITHUB_ENV'),
      Object.entries(database)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
      { flag: 'a' },
    )
  } else if (process.argv[2] === 'verify') {
    const report = await verifyProduction(outputs(), {
      aws,
      fetch,
      accessTeamDomain: env('CLOUDFLARE_ACCESS_TEAM_DOMAIN'),
      lambdaCodeSha256: Buffer.from(
        sha256(readFileSync('packages/api/dist/api-lambda.zip')),
        'hex',
      ).toString('base64'),
      wait: () => setTimeout(5_000),
    })
    writeFileSync(
      `${directory}/infrastructure-verification.json`,
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    )
    for (const check of report.checks)
      console.log(`${check.name}: ${check.status} (${check.attempts} attempts) — ${check.detail}`)
    if (!report.success) process.exitCode = 1
  } else throw new Error('Unknown verification command')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Production verification prerequisites or output schema failed; sensitive diagnostics omitted.',
    )
    process.exitCode = 1
  })
