import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyProduction } from './verify-production.ts'

const output = (value: string) => ({ value })
const outputs = {
  web_bucket: output('web'),
  cloudfront_distribution_id: output('distribution'),
  api_lambda_function_name: output('lambda'),
  web_url: output('https://new-web.example'),
  api_url: output('https://new-api.example'),
  database_driver: output('data-api'),
  database_name: output('recipes'),
  database_resource_arn: output('SECRET_CLUSTER_ARN'),
  database_secret_arn: output('SECRET_DATABASE_ARN'),
}
function dependencies() {
  return {
    accessTeamDomain: 'team.cloudflareaccess.com',
    lambdaCodeSha256: 'matching-code',
    wait: async () => {},
    fetch: async () =>
      new Response(null, {
        status: 303,
        headers: { location: 'https://team.cloudflareaccess.com/login' },
      }),
    aws: (args: string[]) => {
      switch (args[1]) {
        case 'get-distribution':
          return { Distribution: { Status: 'Deployed', DistributionConfig: { Enabled: true } } }
        case 'get-api-mappings':
          return { Items: [{ ApiId: 'api' }, { ApiId: 'additional-api' }] }
        case 'get-api':
          return { DisableExecuteApiEndpoint: true }
        case 'get-function-configuration':
          return { CodeSha256: 'matching-code' }
        default:
          throw new Error('Unexpected AWS request')
      }
    },
  }
}
test('minimal checks accept changed domains, multiple API mappings and valid Access responses without incidental headers', async () => {
  for (const status of [301, 302, 303, 307, 308, 401, 403]) {
    const deps = dependencies()
    deps.fetch = async () =>
      new Response(null, {
        status,
        headers: { location: 'https://team.cloudflareaccess.com/login' },
      })
    const report = await verifyProduction(outputs, deps)
    assert.equal(report.success, true)
    assert.equal(report.checks.length, 5)
    assert.ok(!JSON.stringify(report).includes('SECRET'))
  }
})
test('transient failures are retried, with a bounded and visible attempt count', async () => {
  const deps = dependencies()
  const original = deps.aws
  let calls = 0,
    waits = 0
  deps.aws = (args) => {
    if (args[1] === 'get-distribution' && ++calls < 3) throw new Error('temporary')
    return original(args)
  }
  deps.wait = async () => {
    waits++
  }
  const report = await verifyProduction(outputs, deps)
  assert.equal(report.success, true)
  assert.equal(report.checks[0]!.attempts, 3)
  assert.equal(waits, 2)
})
test('public endpoints, wrong login redirects and TLS errors fail without exposing arbitrary diagnostics', async () => {
  for (const fetch of [
    async () => new Response('SECRET_BODY', { status: 200 }),
    async () =>
      new Response(null, { status: 302, headers: { location: 'https://wrong.example/login' } }),
    async () => {
      throw new Error('SECRET_TLS_DIAGNOSTIC')
    },
  ]) {
    const report = await verifyProduction(outputs, { ...dependencies(), fetch })
    assert.equal(report.success, false)
    assert.ok(
      report.checks
        .filter((check) => check.name.endsWith('https-access'))
        .every((check) => check.status === 'failed' && check.attempts === 3),
    )
    assert.ok(!JSON.stringify(report).includes('SECRET'))
  }
})
test('code mismatches and enabled API default endpoints still fail with useful safe reasons', async () => {
  const deps = dependencies(),
    original = deps.aws
  deps.aws = (args) =>
    args[1] === 'get-api' ? { DisableExecuteApiEndpoint: false } : original(args)
  const report = await verifyProduction(outputs, { ...deps, lambdaCodeSha256: 'different-build' })
  assert.equal(report.success, false)
  assert.match(
    report.checks.find((check) => check.name === 'lambda-exact-code')!.detail,
    /does not match/,
  )
  assert.match(
    report.checks.find((check) => check.name === 'api-gateway-default-endpoint-disabled')!.detail,
    /default endpoint enabled/,
  )
})
test('malformed outputs or unsafe URLs cannot enter verification or GitHub environment files', async () => {
  for (const input of [
    {},
    { ...outputs, api_url: output('http://insecure.example') },
    { ...outputs, api_url: output('https://user:password@example.com') },
    { ...outputs, web_bucket: output('bucket\ninjected=value') },
  ])
    await assert.rejects(() => verifyProduction(input, dependencies()))
})
