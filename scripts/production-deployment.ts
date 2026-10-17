import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  openSync,
  closeSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { inspectPlan, renderPolicyReport } from './deployment-policy.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.object({
  repository: z.string(),
  runId: z.string(),
  runAttempt: z.string(),
  commit: z.string(),
  account: z.string().regex(/^\d{12}$/),
  region: z.string(),
  bucket: z.string(),
  backendKey: z.string(),
  workspace: z.string(),
  workspacePath: z.string(),
  terraformVersion: z.string(),
  configurationSha256: digest,
  providerLockSha256: digest,
})
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  identity: identitySchema,
  createdAt: z.iso.datetime(),
  files: z.record(z.string(), digest),
})
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

const root = process.cwd()
const directory = resolve(root, '.local/deploy')
const tf = 'infra/terraform/prod'
let phase = 'command-inputs'
// Only errors created here have safe, controlled messages; never echo provider/parser errors.
class DeploymentBlocked extends Error {}
const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new DeploymentBlocked(`Missing ${name}`)
  return value
}
const run = (command: string, args: string[]) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const write = (name: string, value: unknown) =>
  writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

function actionsOnly() {
  phase = 'actions-only-main-run'
  if (env('GITHUB_ACTIONS') !== 'true' || env('GITHUB_REF') !== 'refs/heads/main')
    throw new DeploymentBlocked('Actions-only production command')
  for (const name of Object.keys(process.env))
    if (name.startsWith('TF_CLI_ARGS') || name.startsWith('TF_LOG')) delete process.env[name]
  process.umask(0o077)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

function terraform(args: string[], log: string, detailedExit = false) {
  phase = `terraform-${args[0]}`
  const descriptor = openSync(resolve(directory, log), 'w', 0o600)
  try {
    const result = spawnSync('terraform', [`-chdir=${tf}`, ...args], {
      stdio: ['ignore', descriptor, descriptor],
    })
    if (result.error || (result.status !== 0 && !(detailedExit && result.status === 2))) {
      const diagnostics = readFileSync(resolve(directory, log), 'utf8')
      // Classify known failures; never copy untrusted diagnostic payloads into public logs.
      const reasons: [RegExp, string][] = [
        [/AccessDenied|Forbidden|StatusCode: 403/i, 'AWS backend access was denied'],
        [
          /No valid credential|ExpiredToken|InvalidClientTokenId/i,
          'AWS credentials are missing or expired',
        ],
        [
          /NoSuchBucket|InvalidBucketName|PermanentRedirect|Invalid AWS Region/i,
          'Check the S3 backend bucket and region',
        ],
        [/Backend configuration changed/i, 'Backend configuration changed'],
        [/Failed to get existing workspaces/i, 'Could not read workspaces from the S3 backend'],
        [
          /checksum|dependency lock file|Provider dependency changes detected/i,
          'Provider lock/checksum validation failed',
        ],
        [
          /Failed to query available provider packages|Failed to install provider/i,
          'Provider registry lookup or installation failed',
        ],
        [/Module not installed/i, 'Terraform modules are not installed'],
        [
          /Unsupported argument|Invalid backend configuration argument/i,
          'Terraform configuration or arguments are unsupported',
        ],
        [/Error acquiring the state lock/i, 'Terraform could not acquire the state lock'],
      ]
      const reason =
        result.error && 'code' in result.error && result.error.code === 'ENOENT'
          ? 'Terraform executable was not found'
          : (reasons.find(([pattern]) => pattern.test(diagnostics))?.[1] ??
            'See private diagnostics')
      const files =
        args[0] === 'fmt'
          ? diagnostics
              .split('\n')
              .filter((line) => /^[A-Za-z0-9_./-]+\.tf$/.test(line))
              .slice(0, 5)
          : []
      throw new DeploymentBlocked(
        `terraform ${args[0]} failed (exit ${result.status ?? 'unknown'}): ${reason}${files.length ? `; formatting: ${files.join(', ')}` : ''}. Raw diagnostics remain private`,
      )
    }
  } finally {
    closeSync(descriptor)
  }
}

// Saved-plan generation is also the test seam for Terraform's detailed exit codes.
// No apply capability is exposed by this module.
export function createSavedPlan(): unknown {
  actionsOnly()
  phase = 'planning-inputs'
  if (env('TF_VAR_terraform_state_bucket') !== env('TF_BACKEND_BUCKET'))
    throw new DeploymentBlocked('Unexpected backend bucket')
  for (const name of [
    'CLOUDFLARE_API_TOKEN',
    'TF_VAR_access_allowed_email',
    'TF_VAR_cloudflare_account_id',
    'TF_VAR_cloudflare_access_team_domain',
    'TF_VAR_cloudflare_zone_id',
    'TF_VAR_github_oidc_subject',
  ])
    env(name)
  const path = resolve(root, 'packages/api/dist/api-lambda.zip')
  write('artifact.tfvars.json', {
    api_lambda_zip_path: path,
    api_lambda_source_code_hash: Buffer.from(sha256(readFileSync(path)), 'hex').toString('base64'),
    aws_profile: null,
    aws_region: env('AWS_REGION'),
  })
  try {
    phase = 'authoritative-terraform-plan'
    terraform(
      [
        'plan',
        '-input=false',
        '-no-color',
        '-detailed-exitcode',
        '-lock-timeout=60s',
        `-var-file=${resolve(directory, 'artifact.tfvars.json')}`,
        `-out=${resolve(directory, 'plan.tfplan')}`,
      ],
      'plan.private.log',
      true,
    )
    phase = 'saved-plan-decoding'
    return JSON.parse(
      run('terraform', [`-chdir=${tf}`, 'show', '-json', resolve(directory, 'plan.tfplan')]),
    )
  } finally {
    rmSync(resolve(directory, 'artifact.tfvars.json'), { force: true })
  }
}

function identity() {
  phase = 'exact-checkout-and-workspace-path'
  if (
    run('git', ['rev-parse', 'HEAD']).trim() !== env('GITHUB_SHA') ||
    root !== env('GITHUB_WORKSPACE')
  )
    throw new DeploymentBlocked('Wrong checkout or workspace path')
  phase = 'pinned-terraform-version'
  const version = z
    .object({ terraform_version: z.literal(env('TERRAFORM_VERSION')) })
    .parse(JSON.parse(run('terraform', ['version', '-json'])))
  phase = 'expected-aws-account'
  const account = z
    .object({ Account: z.string() })
    .parse(JSON.parse(run('aws', ['sts', 'get-caller-identity', '--output', 'json']))).Account
  // The existing deployment role identifies the intended account; no extra repo variable is needed.
  const expectedAccount = z
    .string()
    .regex(/^\d{12}$/)
    .parse(env('AWS_DEPLOY_ROLE_ARN').split(':')[4])
  if (account !== expectedAccount) throw new DeploymentBlocked('Unexpected AWS account')
  phase = 'backend-region-key-and-workspace'
  const workspace = run('terraform', [`-chdir=${tf}`, 'workspace', 'show']).trim()
  if (workspace !== env('TF_WORKSPACE'))
    throw new DeploymentBlocked('Unexpected Terraform workspace')
  const backend = z
    .object({
      backend: z.object({
        type: z.literal('s3'),
        config: z.object({
          bucket: z.string(),
          key: z.string().min(1),
          region: z.string().min(1),
        }),
      }),
    })
    .parse(json(`${tf}/.terraform/terraform.tfstate`))
  if (backend.backend.config.bucket !== env('TF_BACKEND_BUCKET'))
    throw new DeploymentBlocked('Unexpected backend bucket')
  const paths = run('git', ['ls-files', 'infra/terraform'])
    .trim()
    .split('\n')
    .filter((path) => path.endsWith('.tf') || path.endsWith('.terraform.lock.hcl'))
    .sort()
  const configurationSha256 = sha256(
    paths.map((path) => `${path}\0${sha256(readFileSync(path))}`).join('\n'),
  )
  phase = 'deployment-identity-and-configuration'
  return identitySchema.parse({
    repository: env('GITHUB_REPOSITORY'),
    runId: env('GITHUB_RUN_ID'),
    runAttempt: env('GITHUB_RUN_ATTEMPT'),
    commit: env('GITHUB_SHA'),
    account,
    region: env('AWS_REGION'),
    bucket: backend.backend.config.bucket,
    backendKey: backend.backend.config.key,
    workspace,
    workspacePath: root,
    terraformVersion: version.terraform_version,
    configurationSha256,
    providerLockSha256: sha256(readFileSync(`${tf}/.terraform.lock.hcl`)),
  })
}
function assertArtifactInputs(input: unknown) {
  phase = 'saved-plan-artifact-and-provider-inputs'
  const path = resolve(root, 'packages/api/dist/api-lambda.zip')
  z.object({
    variables: z.object({
      api_lambda_zip_path: z.object({ value: z.literal(path) }),
      api_lambda_source_code_hash: z.object({
        value: z.literal(Buffer.from(sha256(readFileSync(path)), 'hex').toString('base64')),
      }),
      aws_profile: z.object({ value: z.null() }),
      aws_region: z.object({ value: z.literal(env('AWS_REGION')) }),
    }),
  }).parse(input)
}
function webFiles(path = 'packages/web/dist'): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(path).flatMap((entry): [string, Buffer][] => {
      const name = `${path}/${entry}`
      const stat = lstatSync(name)
      if (stat.isSymbolicLink()) throw new DeploymentBlocked('Artifact symlink refused')
      return stat.isDirectory() ? Object.entries(webFiles(name)) : [[name, readFileSync(name)]]
    }),
  )
}
function deploymentFiles() {
  return Object.fromEntries(
    Object.entries({
      ...webFiles(),
      '.local/deploy/plan.tfplan': readFileSync(resolve(directory, 'plan.tfplan')),
      'packages/api/dist/api-lambda.zip': readFileSync('packages/api/dist/api-lambda.zip'),
    })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, data]) => [path, sha256(data)]),
  )
}
function policy(input: unknown) {
  phase = 'structured-plan-policy'
  const report = {
    ...inspectPlan(input),
    authority: 'actions-saved-plan' as const,
  }
  write('policy.json', report)
  writeFileSync(resolve(directory, 'policy.md'), renderPolicyReport(report, report.authority), {
    mode: 0o600,
  })
  return report
}
async function main() {
  actionsOnly()
  const command = process.argv[2]
  if (command === 'init') {
    const bucket = env('TF_BACKEND_BUCKET')
    phase = 'terraform-format-initialize-and-validate'
    terraform(['fmt', '-check', '-recursive', '../'], 'fmt.private.log')
    terraform(
      ['init', '-input=false', '-lockfile=readonly', `-backend-config=bucket=${bucket}`],
      'init.private.log',
    )
    terraform(['validate', '-no-color'], 'validate.private.log')
    identity()
  } else if (command === 'plan') {
    identity()
    const plan = createSavedPlan()
    assertArtifactInputs(plan)
    const report = policy(plan)
    if (!report.policyPassed)
      throw new DeploymentBlocked('Known exposure violations; inspect policy.json/policy.md')
    phase = 'web-build-from-planned-api-url'
    const apiUrl = z
      .object({
        planned_values: z.object({
          outputs: z.object({
            api_url: z.object({
              value: z.url().refine((value) => {
                const url = new URL(value)
                return url.protocol === 'https:' && !url.username && !url.password
              }),
            }),
          }),
        }),
      })
      .parse(plan).planned_values.outputs.api_url.value
    const buildLog = openSync(resolve(directory, 'web-build.private.log'), 'w', 0o600)
    try {
      const build = spawnSync('pnpm', ['--filter', '@recipes/web', 'build'], {
        env: { ...process.env, VITE_API_URL: apiUrl },
        stdio: ['ignore', buildLog, buildLog],
      })
      if (build.error || build.status !== 0)
        throw new DeploymentBlocked('Web build failed; diagnostics remain private')
    } finally {
      closeSync(buildLog)
    }
    const files = deploymentFiles()
    if (!Object.hasOwn(files, 'packages/web/dist/index.html'))
      throw new DeploymentBlocked('Missing web index.html')
    const manifest = manifestSchema.parse({
      schemaVersion: 1,
      identity: identity(),
      createdAt: new Date().toISOString(),
      files,
    })
    // Only hashes/identities leave this runner. The binary plan and builds stay in this job.
    write('manifest.json', manifest)
    writeFileSync(
      env('GITHUB_STEP_SUMMARY'),
      readFileSync(resolve(directory, 'policy.md')) +
        `\nCommit: ${manifest.identity.commit}\nRun: ${manifest.identity.runId}\nSaved plan SHA-256: ${manifest.files['.local/deploy/plan.tfplan']}\n`,
      { flag: 'a' },
    )
  } else if (command === 'confirm-apply') {
    const expected = identity()
    phase = 'same-job-plan-and-build-integrity'
    const manifest = manifestSchema.parse(json(resolve(directory, 'manifest.json')))
    if (JSON.stringify(manifest.identity) !== JSON.stringify(expected))
      throw new DeploymentBlocked('Deployment target or source changed since planning')
    const files = deploymentFiles()
    if (
      Object.keys(manifest.files).length !== Object.keys(files).length ||
      Object.entries(files).some(([path, hash]) => manifest.files[path] !== hash)
    )
      throw new DeploymentBlocked('Plan or build changed since planning')
  } else throw new DeploymentBlocked('Unknown deployment command')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // Parser and provider errors may contain sensitive input.
    const detail =
      error instanceof DeploymentBlocked
        ? error.message
        : 'Required command, schema or integrity validation failed; sensitive diagnostics omitted.'
    console.error(`Deployment blocked at ${phase}: ${detail}. No fallback plan is permitted.`)
    try {
      write('prerequisite-failure.json', { schemaVersion: 1, success: false, phase, detail })
    } catch {
      /* The safe log remains available if local storage failed. */
    }
    process.exitCode = 1
  })
