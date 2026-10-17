import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { summarizePlan, renderReport } from './infra-plan.mjs'

const secret = 'DO_NOT_EXPOSE_THIS_SECRET'
const helper = fileURLToPath(new URL('./infra-plan.mjs', import.meta.url))
const resource = () => ({
  address: `module.app.example.token["${secret}"]`,
  type: 'example',
  change: {
    actions: ['create'],
    before: null,
    after: { client_secret: secret, client_id: secret, [secret + '\n']: secret },
    after_sensitive: { client_secret: true },
    after_unknown: { id: true },
  },
})
const plan = (resources) => ({ format_version: '1.2', resource_changes: resources })
test('local metadata reports omit values, identifying instance keys and generic computed-value warnings', () => {
  const report = summarizePlan({
    ...plan([resource()]),
    variables: { token: { value: secret } },
    output_changes: { token: { actions: ['create'], after: secret } },
  })
  assert.equal(report.applied, false)
  assert.equal(report.actionableResources, 1)
  assert.equal(report.resources[0].address, 'module.app.example.token[*]')
  assert.equal(report.resources[0].containsSensitiveAttributes, true)
  assert.deepEqual(report.resources[0].changedAttributes, ['client_id', 'client_secret'])
  assert.ok(!JSON.stringify(report).includes(secret))
  assert.ok(!renderReport(report).includes(secret))
  assert.ok(!renderReport(report).includes('known after apply'))
  assert.deepEqual(report.outputs, [{ name: 'token', actions: ['create'] }])
  assert.deepEqual(
    summarizePlan(plan([{ ...resource(), change: { actions: ['no-op'] } }])).resources,
    [],
  )
})
test('malformed and incomplete local report inputs fail closed', () => {
  for (const input of [
    null,
    {},
    { format_version: '2.0' },
    { ...plan([]), complete: false },
    plan([{ ...resource(), change: { actions: ['unexpected'] } }]),
    { ...plan([]), resource_changes: {} },
  ])
    assert.throws(() => summarizePlan(input))
})
test('command parse failures never echo secret-bearing input', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-plan-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'malformed.json')
  writeFileSync(input, `{"secret": "${secret}", invalid JSON`)
  const result = spawnSync(process.execPath, [helper, 'report', input, directory, process.cwd()], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Plan helper failed/)
  assert.ok(!result.stdout.includes(secret))
  assert.ok(!result.stderr.includes(secret))
})
test('backend metadata inspection cannot expose credential fields', (t) => {
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
  const result = spawnSync(process.execPath, [helper, 'backend-value', input, 'access_key'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.ok(!result.stderr.includes(secret))
})
test('local provider selection pins the confirmed region/profile without persisting credentials', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-provider-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'artifact.json')
  writeFileSync(
    input,
    JSON.stringify({ api_lambda_zip_path: '/artifact.zip', api_lambda_source_code_hash: 'hash' }),
  )
  const result = spawnSync(process.execPath, [helper, 'provider-inputs', input], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TF_PROVIDER_PROFILE: '',
      AWS_EXPECTED_REGION: 'eu-west-1',
      CLOUDFLARE_API_TOKEN: secret,
    },
  })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(readFileSync(input, 'utf8')), {
    api_lambda_zip_path: '/artifact.zip',
    api_lambda_source_code_hash: 'hash',
    aws_profile: null,
    aws_region: 'eu-west-1',
  })
  assert.ok(!readFileSync(input, 'utf8').includes(secret))
})

function previewFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-latest-preview-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const runs = join(directory, '.local/infra-plan')
  const older = join(runs, '20261016T120000Z-older')
  const newest = join(runs, '20261016T130000Z-newest')
  for (const path of [older, newest]) {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'plan.tfplan'), 'PRIVATE_BINARY_FIXTURE')
    writeFileSync(join(path, 'report.json'), '{}')
    writeFileSync(join(path, 'report.md'), 'Completed preview')
  }
  // Touching an older run must not make it the newest preview.
  utimesSync(older, new Date('2030-01-01'), new Date('2030-01-01'))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const fixture = join(directory, 'plan-fixture.json')
  writeFileSync(
    fixture,
    JSON.stringify({ ...plan([{ ...resource(), mode: 'managed' }]), terraform_version: '1.15.8' }),
  )
  const calls = join(directory, 'calls')
  writeFileSync(
    join(bin, 'terraform'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *' show -json '*)
    if [ "\${SHOW_FAIL:-}" = 1 ]; then printf '${secret}'; printf '${secret}' >&2; exit 1; fi
    cat "$PLAN_FIXTURE" ;;
  *' show -no-color '*) printf 'PRIVATE_REVIEW_FIXTURE' ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o700 },
  )
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('REVIEW_') && name !== 'PLAN_JSON_PATH',
    ),
  )
  const env = { ...clean, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, PLAN_FIXTURE: fixture }
  return { directory, runs, older, newest, calls, env }
}

test('inspect needs no paths: it reads only the newest saved preview and prints a redacted report', (t) => {
  const fixture = previewFixture(t)
  const result = spawnSync(process.execPath, [helper, 'inspect'], {
    cwd: fixture.directory,
    env: fixture.env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /20261016T130000Z-newest/)
  assert.match(result.stdout, /example.token\[\*\]/)
  assert.ok(!result.stdout.includes(secret))
  assert.ok(!result.stderr.includes(secret))
  assert.match(
    readFileSync(fixture.calls, 'utf8'),
    /show -json .*20261016T130000Z-newest\/plan.tfplan/,
  )
  assert.ok(!readFileSync(fixture.calls, 'utf8').includes('20261016T120000Z-older/plan.tfplan'))
  const report = JSON.parse(readFileSync(join(fixture.newest, 'policy.json'), 'utf8'))
  assert.equal(report.previewRun, '20261016T130000Z-newest')
  assert.equal(report.authority, 'local-preview')
  assert.match(report.planSha256, /^[a-f0-9]{64}$/)
  assert.equal(statSync(join(fixture.newest, 'policy.json')).mode & 0o077, 0)
})

test('an absent or unfinished newest preview is reported rather than falling back to an older plan', (t) => {
  const fixture = previewFixture(t)
  const failed = join(fixture.runs, '20261016T140000Z-failed')
  mkdirSync(failed)
  const result = spawnSync(process.execPath, [helper, 'inspect'], {
    cwd: fixture.directory,
    env: fixture.env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /did not finish/)
  assert.match(result.stderr, /no older plan was selected/)
  assert.ok(!existsSync(fixture.calls))
  rmSync(fixture.runs, { recursive: true })
  const missing = spawnSync(process.execPath, [helper, 'inspect'], {
    cwd: fixture.directory,
    env: fixture.env,
    encoding: 'utf8',
  })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Run pnpm infra:preview first/)
})

test('failed plan decoding keeps diagnostics private and never invokes plan or apply', (t) => {
  const fixture = previewFixture(t)
  const result = spawnSync(process.execPath, [helper, 'inspect'], {
    cwd: fixture.directory,
    env: { ...fixture.env, SHOW_FAIL: '1' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Could not read the newest saved plan/)
  assert.ok(!result.stdout.includes(secret))
  assert.ok(!result.stderr.includes(secret))
  assert.ok(readFileSync(join(fixture.newest, 'inspect.private.log'), 'utf8').includes(secret))
  assert.ok(!existsSync(join(fixture.newest, 'policy.json')))
  const calls = readFileSync(fixture.calls, 'utf8').trim().split('\n')
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^-chdir=.* show -json /)
})

test('private review needs no paths but refuses to expose the plan through a pipe or agent tool', (t) => {
  const fixture = previewFixture(t)
  const result = spawnSync(process.execPath, [helper, 'review'], {
    cwd: fixture.directory,
    env: fixture.env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /private terminal/)
  assert.ok(!existsSync(fixture.calls))
  // Simulate the terminal flag in this isolated fixture, never against a real private plan.
  const preload = join(fixture.directory, 'terminal-fixture.mjs')
  writeFileSync(preload, 'Object.defineProperty(process.stdout, "isTTY", { value: true });')
  const terminal = spawnSync(process.execPath, ['--import', preload, helper, 'review'], {
    cwd: fixture.directory,
    env: fixture.env,
    encoding: 'utf8',
  })
  assert.equal(terminal.status, 0, terminal.stderr)
  assert.match(terminal.stdout, /20261016T130000Z-newest/)
  assert.match(terminal.stdout, /Nothing is approved or applied/)
  assert.match(terminal.stdout, /PRIVATE_REVIEW_FIXTURE/)
  assert.match(
    readFileSync(fixture.calls, 'utf8'),
    /show -no-color .*20261016T130000Z-newest\/plan.tfplan/,
  )
})
