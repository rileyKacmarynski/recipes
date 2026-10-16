import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { summarizePlan, renderReport } from './infra-plan.mjs'

const secret = 'DO_NOT_EXPOSE_THIS_SECRET'
const resource = (overrides = {}) => ({
  address: 'module.app.cloudflare_zero_trust_access_service_token.smoke',
  type: 'cloudflare_zero_trust_access_service_token',
  change: {
    actions: ['create'],
    before: null,
    after: { client_secret: secret, client_id: secret },
    after_sensitive: { client_secret: true },
    after_unknown: { id: true },
  },
  ...overrides,
})
const plan = (resources) => ({ format_version: '1.2', resource_changes: resources })

test('reports actions and review findings without copying any attribute or output values', () => {
  const input = {
    ...plan([resource()]),
    variables: { token: { value: secret } },
    output_changes: { token: { actions: ['create'], after: secret } },
  }
  const report = summarizePlan(input)
  assert.equal(report.actionableResources, 1)
  assert.equal(report.applied, false)
  assert.equal(report.resources[0].containsSensitiveAttributes, true)
  assert.deepEqual(report.resources[0].changedAttributes, ['client_id', 'client_secret'])
  assert.ok(report.resources[0].findings.some((finding) => finding.includes('Access')))
  assert.ok(report.resources[0].findings.some((finding) => finding.includes('known after apply')))
  assert.ok(!JSON.stringify(report).includes(secret))
  assert.ok(!renderReport(report).includes(secret))
  assert.deepEqual(report.outputs, [{ name: 'token', actions: ['create'] }])
})

test('redacts identifying instance keys and unsafe attribute names', () => {
  const report = summarizePlan(
    plan([
      resource({
        address: `module.app.example.record["${secret}"]`,
        change: { actions: ['update'], before: {}, after: { [secret + '\n']: secret } },
      }),
    ]),
  )
  assert.equal(report.resources[0].address, 'module.app.example.record[*]')
  assert.deepEqual(report.resources[0].changedAttributes, [])
  assert.ok(!JSON.stringify(report).includes(secret))
})

test('flags replacements and leaves no-op plans unambiguous', () => {
  const report = summarizePlan(plan([resource({ change: { actions: ['delete', 'create'] } })]))
  assert.ok(report.resources[0].findings.some((finding) => finding.includes('replacement')))
  const unchanged = summarizePlan(
    plan([resource({ type: 'example', change: { actions: ['no-op'] } })]),
  )
  assert.equal(unchanged.actionableResources, 0)
  assert.deepEqual(unchanged.resources, [])
})

test('flags unsafe or unknown endpoint settings without exposing their values', () => {
  for (const value of [false, undefined]) {
    const report = summarizePlan(
      plan([
        resource({
          type: 'aws_apigatewayv2_api',
          change: { actions: ['update'], after: { disable_execute_api_endpoint: value } },
        }),
      ]),
    )
    assert.ok(report.resources[0].findings.some((finding) => finding.includes('default endpoint')))
  }
})

test('distinguishes proxied address records from non-proxied CAA records', () => {
  const report = summarizePlan(
    plan([
      resource({
        address: 'cloudflare_record.api',
        type: 'cloudflare_record',
        change: { actions: ['update'], after: { type: 'CNAME', proxied: false, value: secret } },
      }),
      resource({
        address: 'cloudflare_record.caa',
        type: 'cloudflare_record',
        change: { actions: ['create'], after: { type: 'CAA', proxied: false, value: secret } },
      }),
    ]),
  )
  assert.ok(report.resources[0].findings.some((finding) => finding.includes('unproxied')))
  assert.deepEqual(report.resources[1].findings, [])
  assert.ok(!JSON.stringify(report).includes(secret))
})

test('reports a public database without reporting credentials', () => {
  const report = summarizePlan(
    plan([
      resource({
        type: 'aws_db_instance',
        change: { actions: ['update'], after: { publicly_accessible: true, password: secret } },
      }),
    ]),
  )
  assert.ok(report.resources[0].findings.some((finding) => finding.includes('publicly accessible')))
  assert.ok(!renderReport(report).includes(secret))
})

test('rejects malformed and incomplete plans rather than producing a misleading success report', () => {
  for (const input of [
    null,
    {},
    { format_version: '2.0' },
    { ...plan([]), complete: false },
    plan([resource({ change: { actions: ['unexpected'] } })]),
    { ...plan([]), resource_changes: {} },
  ]) {
    assert.throws(() => summarizePlan(input))
  }
})

test('the command-line boundary reports parse failures without echoing secret-bearing input', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-plan-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'malformed.json')
  writeFileSync(input, `{"secret": "${secret}", invalid JSON`)
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./infra-plan.mjs', import.meta.url)),
      'report',
      input,
      directory,
      process.cwd(),
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Plan helper failed/)
  assert.ok(!result.stdout.includes(secret))
  assert.ok(!result.stderr.includes(secret))
})

test('backend lookup supports cached state coordinates without exposing credential fields', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-backend-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'backend.json')
  writeFileSync(
    input,
    JSON.stringify({
      backend: {
        type: 's3',
        config: {
          bucket: 'test-bucket',
          key: 'prod/terraform.tfstate',
          region: 'us-east-1',
          access_key: secret,
        },
      },
    }),
  )
  const helper = fileURLToPath(new URL('./infra-plan.mjs', import.meta.url))
  for (const [field, expected] of [
    ['profile', ''],
    ['key', 'prod/terraform.tfstate'],
    ['region', 'us-east-1'],
  ]) {
    const result = spawnSync(process.execPath, [helper, 'backend-value', input, field], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, expected)
  }
  const denied = spawnSync(process.execPath, [helper, 'backend-value', input, 'access_key'], {
    encoding: 'utf8',
  })
  assert.equal(denied.status, 1)
  assert.ok(!`${denied.stdout}${denied.stderr}`.includes(secret))
})
