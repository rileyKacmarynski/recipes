import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { inspectPlan } from './deployment-policy.ts'

const terraformVersion = '1.15.8'
const idQualifiedSubject =
  'repo:rileyKacmarynski@28719606/recipes@1324636296:environment:production'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const resource = (
  type: string,
  after: Record<string, unknown>,
  actions = ['create'],
  unknown = {},
  before = {},
) => ({
  address: `module.anywhere.${type}.new_resource`,
  type,
  mode: 'managed',
  change: { actions, before, after, after_unknown: unknown },
})
const plan = (resources: unknown[] = []) => ({
  format_version: '1.2',
  terraform_version: terraformVersion,
  resource_changes: resources,
})

test(
  'the actual Terraform variable accepts the configured ID-qualified OIDC subject',
  {
    skip:
      spawnSync('terraform', ['version'], { stdio: 'ignore' }).status !== 0 &&
      'Terraform CLI unavailable',
  },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'recipes-oidc-variable-test-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const declaration = readFileSync('infra/terraform/prod/variables.tf', 'utf8').match(
      /variable "github_oidc_subject" \{[\s\S]*?\n\}/,
    )?.[0]
    assert.ok(declaration)
    writeFileSync(
      join(directory, 'main.tf'),
      declaration + '\noutput "subject" { value = var.github_oidc_subject }\n',
    )
    // No providers or backend: this fixture never contacts AWS/Cloudflare.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('TF_')),
    )
    const init = spawnSync(
      'terraform',
      [`-chdir=${directory}`, 'init', '-backend=false', '-input=false', '-no-color'],
      { env, encoding: 'utf8' },
    )
    assert.equal(init.status, 0, init.stderr)
    const result = spawnSync(
      'terraform',
      [
        `-chdir=${directory}`,
        'plan',
        '-input=false',
        '-lock=false',
        '-no-color',
        `-var=github_oidc_subject=${idQualifiedSubject}`,
        '-out=fixture.tfplan',
      ],
      { env, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const shown = spawnSync(
      'terraform',
      [`-chdir=${directory}`, 'show', '-json', 'fixture.tfplan'],
      { env, encoding: 'utf8' },
    )
    assert.equal(shown.status, 0)
    assert.equal(JSON.parse(shown.stdout).variables.github_oidc_subject.value, idQualifiedSubject)
  },
)
test('new resources, renamed modules, extra hostnames and DNS-only records do not need a separate inventory', () => {
  const resources = [
    resource('aws_s3_bucket', {}),
    resource('aws_lambda_function', {}),
    resource('cloudflare_record', {
      type: 'CNAME',
      name: '_validation.new.example',
      proxied: false,
    }),
    resource('aws_acm_certificate', {
      domain_name: 'new.example',
      subject_alternative_names: ['extra.example'],
    }),
    resource('aws_cloudfront_distribution', { aliases: ['new.example', 'extra.example'] }),
  ]
  const report = inspectPlan(plan(resources))
  assert.equal(report.policyPassed, true)
  assert.equal(report.resources.length, resources.length)
  assert.equal(inspectPlan(plan()).policyPassed, true)
  assert.ok(report.findings.every((finding) => finding.severity === 'review'))
})
test('known public exposure and missing database encryption still block regardless of resource name', () => {
  const report = inspectPlan(
    plan([
      resource('aws_apigatewayv2_api', { disable_execute_api_endpoint: false }),
      resource('aws_db_instance', { publicly_accessible: true }),
      resource('aws_rds_cluster_instance', { publicly_accessible: true }),
      resource('aws_rds_cluster', { storage_encrypted: false }),
    ]),
  )
  assert.equal(report.policyPassed, false)
  for (const rule of ['api-default-endpoint', 'public-database', 'database-encryption'])
    assert.ok(
      report.findings.some((finding) => finding.rule === rule && finding.severity === 'violation'),
    )
})
test('security unknowns remain visible without warnings for ordinary generated metadata', () => {
  const report = inspectPlan(
    plan([
      resource('aws_apigatewayv2_api', {}, ['create'], {
        disable_execute_api_endpoint: true,
        id: true,
      }),
      resource('aws_db_instance', {}, ['create'], { publicly_accessible: true }),
      resource('aws_rds_cluster', {}, ['create'], { storage_encrypted: true }),
      resource('aws_s3_bucket', {}, ['create'], { id: true, arn: true }),
    ]),
  )
  assert.equal(report.policyPassed, true)
  assert.deepEqual(
    report.findings.map((finding) => finding.rule),
    ['api-default-endpoint', 'public-database', 'database-encryption'],
  )
  assert.ok(report.findings.every((finding) => finding.severity === 'unresolved'))
})
test('architectural changes are reported, not held for approval inside Actions', () => {
  const report = inspectPlan(
    plan([
      resource('aws_s3_bucket', {}, ['delete']),
      resource('cloudflare_zero_trust_access_policy', {}),
      resource('aws_iam_role', {}),
      resource('cloudflare_record', { type: 'CAA', name: 'another.example', data: [] }),
      resource(
        'aws_rds_cluster',
        { storage_encrypted: true, deletion_protection: false },
        ['update'],
        {},
        { deletion_protection: true },
      ),
    ]),
  )
  assert.equal(report.policyPassed, true)
  for (const rule of [
    'destruction-or-replacement',
    'access-change',
    'iam-change',
    'caa-change',
    'database-deletion-protection-change',
  ])
    assert.ok(
      report.findings.some((finding) => finding.rule === rule && finding.severity === 'review'),
    )
})
test('malformed/incomplete plans fail and redacted reports never copy secret values or instance keys', () => {
  for (const input of [
    null,
    {},
    { ...plan(), format_version: '2.0' },
    { ...plan(), complete: false },
    { ...plan(), errored: true },
    { ...plan(), resource_changes: {} },
    plan([resource('aws_s3_bucket', {}, ['approve'])]),
  ])
    assert.throws(() => inspectPlan(input))
  const secret = 'TOP_SECRET'
  const report = inspectPlan(
    plan([
      {
        ...resource('cloudflare_zero_trust_access_policy', { password: secret }),
        address: `module.app.cloudflare_zero_trust_access_policy.token["${secret}"]`,
      },
    ]),
  )
  assert.ok(!JSON.stringify(report).includes(secret))
  assert.ok(report.resources[0]!.address.endsWith('[*]'))
})
test('local review refuses obsolete Actions download/decrypt inputs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-review-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [resolve('scripts/infra-plan.mjs'), 'review'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_HANDOFF_PATH: '/not-a-local-preview/handoff.json' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Actions plans stay on the runner/)
  assert.equal(result.stdout, '')
})
test('Actions handles detailed plan exit codes without logging diagnostics or falling back to apply', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-actions-plan-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'bin'))
  mkdirSync(join(directory, 'packages/api/dist'), { recursive: true })
  writeFileSync(join(directory, 'packages/api/dist/api-lambda.zip'), 'MATCHING_API')
  const log = join(directory, 'calls')
  writeFileSync(
    join(directory, 'bin/terraform'),
    `#!/bin/bash
printf '%s\\n' "$*" >>"$CALLS"
[[ -z "\${TF_CLI_ARGS_plan:-}" && -z "\${TF_LOG:-}" ]] || exit 99
case "$*" in
  *' plan '*) echo SECRET_PROVIDER_DIAGNOSTIC; exit "$PLAN_STATUS" ;;
  *' show '*) printf '{}' ;;
  *) exit 99 ;;
esac\n`,
    { mode: 0o700 },
  )
  const module = pathToFileURL(resolve('scripts/production-deployment.ts')).href
  for (const status of [0, 2, 1, 3]) {
    writeFileSync(log, '')
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createSavedPlan } from ${JSON.stringify(module)}; try { createSavedPlan(); console.log('SAVED_PLAN_CREATED'); } catch { process.exitCode = 1; }`,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
          CALLS: log,
          PLAN_STATUS: String(status),
          GITHUB_ACTIONS: 'true',
          GITHUB_REF: 'refs/heads/main',
          AWS_REGION: 'us-east-1',
          TF_CLI_ARGS_plan: '-destroy',
          TF_LOG: 'TRACE',
          CLOUDFLARE_API_TOKEN: 'secret',
          TF_VAR_access_allowed_email: 'secret',
          TF_VAR_cloudflare_account_id: 'secret',
          TF_VAR_cloudflare_access_team_domain: 'secret',
          TF_VAR_cloudflare_zone_id: 'secret',
          TF_VAR_terraform_state_bucket: 'backend',
          TF_BACKEND_BUCKET: 'backend',
          TF_VAR_github_oidc_subject: idQualifiedSubject,
        },
      },
    )
    const success = [0, 2].includes(status)
    assert.equal(result.status, success ? 0 : 1)
    assert.equal(result.stdout.includes('SAVED_PLAN_CREATED'), success)
    assert.equal(readFileSync(log, 'utf8').includes(' show '), success)
    assert.ok(!readFileSync(log, 'utf8').includes('apply'))
    assert.ok(!result.stdout.includes('SECRET_PROVIDER_DIAGNOSTIC'))
    assert.ok(!result.stderr.includes('SECRET_PROVIDER_DIAGNOSTIC'))
    assert.ok(!existsSync(join(directory, '.local/deploy/artifact.tfvars.json')))
  }
})
test('one job plans and verifies its builds without GitHub approval APIs, transfer, or encryption keys', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'recipes-same-job-test-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const path of ['bin', 'packages/api/dist', 'infra/terraform/prod/.terraform'])
    mkdirSync(join(directory, path), { recursive: true })
  writeFileSync(join(directory, 'packages/api/dist/api-lambda.zip'), 'MATCHING_API')
  writeFileSync(join(directory, 'infra/terraform/prod/main.tf'), '# fixture')
  writeFileSync(join(directory, 'infra/terraform/prod/.terraform.lock.hcl'), '# pinned fixture')
  writeFileSync(
    join(directory, 'infra/terraform/prod/.terraform/terraform.tfstate'),
    JSON.stringify({
      backend: {
        type: 's3',
        config: { bucket: 'backend', key: 'prod/terraform.tfstate', region: 'us-east-1' },
      },
    }),
  )
  const commit = 'a'.repeat(40),
    account = '123456789012'
  const executable = (name: string, body: string) =>
    writeFileSync(join(directory, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o700 })
  executable(
    'git',
    `case "$*" in 'rev-parse HEAD') printf '${commit}' ;; 'ls-files infra/terraform') printf 'infra/terraform/prod/main.tf\\ninfra/terraform/prod/.terraform.lock.hcl' ;; *) exit 1 ;; esac`,
  )
  executable('aws', `printf '${JSON.stringify({ Account: account })}'`)
  const savedPlan = {
    ...plan(),
    variables: {
      api_lambda_zip_path: { value: join(directory, 'packages/api/dist/api-lambda.zip') },
      api_lambda_source_code_hash: {
        value: Buffer.from(sha256('MATCHING_API'), 'hex').toString('base64'),
      },
      aws_profile: { value: null },
      aws_region: { value: 'us-east-1' },
    },
    planned_values: { outputs: { api_url: { value: 'https://new-api.example' } } },
  }
  const planFile = join(directory, 'plan-fixture.json'),
    calls = join(directory, 'calls')
  writeFileSync(planFile, JSON.stringify(savedPlan))
  executable(
    'terraform',
    `printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  'version -json') printf '${JSON.stringify({ terraform_version: terraformVersion })}' ;;
  *' workspace show') printf default ;;
  *' plan '*) printf 'PRIVATE_PLAN' > "$GITHUB_WORKSPACE/.local/deploy/plan.tfplan"; exit 2 ;;
  *' show '*) cat "$PLAN_FIXTURE" ;;
  *) exit 1 ;;
esac`,
  )
  executable(
    'pnpm',
    'mkdir -p packages/web/dist; printf \'%s\' "$VITE_API_URL" > packages/web/dist/index.html',
  )
  const preload = join(directory, 'no-github-api.mjs')
  writeFileSync(
    preload,
    'globalThis.fetch = async () => { throw new Error("No approval API calls allowed"); };',
  )
  const env = {
    ...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
    PLAN_FIXTURE: planFile,
    CALLS: calls,
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'owner/recipes',
    GITHUB_WORKSPACE: directory,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SHA: commit,
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    AWS_REGION: 'us-east-1',
    AWS_EXPECTED_ACCOUNT_ID: '',
    AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${account}:role/deploy`,
    TF_WORKSPACE: 'default',
    TERRAFORM_VERSION: terraformVersion,
    TF_BACKEND_BUCKET: 'backend',
    TF_VAR_terraform_state_bucket: 'backend',
    TF_VAR_github_oidc_subject: idQualifiedSubject,
    CLOUDFLARE_API_TOKEN: 'private',
    TF_VAR_access_allowed_email: 'private',
    TF_VAR_cloudflare_account_id: 'private',
    TF_VAR_cloudflare_access_team_domain: 'private',
    TF_VAR_cloudflare_zone_id: 'private',
    GH_TOKEN: '',
    DEPLOY_PLAN_PUBLIC_KEY: '',
    DEPLOY_PLAN_PRIVATE_KEY: '',
  }
  const execute = (command: string, overrides = {}) =>
    spawnSync(
      process.execPath,
      ['--import', preload, resolve('scripts/production-deployment.ts'), command],
      { cwd: directory, encoding: 'utf8', env: { ...env, ...overrides } },
    )
  const planned = execute('plan')
  assert.equal(planned.status, 0, planned.stderr)
  const manifest = JSON.parse(readFileSync(join(directory, '.local/deploy/manifest.json'), 'utf8'))
  assert.equal(manifest.identity.runAttempt, '2')
  assert.equal(manifest.identity.account, account)
  assert.equal(manifest.files['.local/deploy/plan.tfplan'], sha256('PRIVATE_PLAN'))
  assert.equal(manifest.files['packages/web/dist/index.html'], sha256('https://new-api.example'))
  assert.ok(!existsSync(join(directory, '.local/deploy/handoff.encrypted.json')))
  assert.equal(execute('confirm-apply').status, 0)
  writeFileSync(join(directory, 'packages/web/dist/index.html'), 'changed')
  assert.equal(execute('confirm-apply').status, 1)
  writeFileSync(join(directory, 'packages/web/dist/index.html'), 'https://new-api.example')
  writeFileSync(join(directory, 'packages/web/dist/unplanned.txt'), 'changed')
  assert.equal(execute('confirm-apply').status, 1)
  rmSync(join(directory, 'packages/web/dist/unplanned.txt'))
  assert.equal(execute('confirm-apply', { GITHUB_RUN_ATTEMPT: '3' }).status, 1)
  assert.equal(
    execute('confirm-apply', { AWS_DEPLOY_ROLE_ARN: 'arn:aws:iam::999999999999:role/wrong' })
      .status,
    1,
  )
  assert.equal(
    readFileSync(calls, 'utf8')
      .split('\n')
      .filter((line) => line.includes(' plan ')).length,
    1,
  )
  assert.ok(!readFileSync(calls, 'utf8').includes('apply'))
  assert.ok(!readFileSync(join(directory, 'summary'), 'utf8').includes('PRIVATE_PLAN'))
})
test('local calls and feature refs are refused; local inspection is never the Actions plan', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-inspect-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const values of [
    { GITHUB_ACTIONS: '', GITHUB_REF: 'refs/heads/main' },
    { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature' },
  ]) {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/production-deployment.ts'), 'plan'],
      { cwd: directory, encoding: 'utf8', env: { ...process.env, ...values } },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Deployment blocked/)
  }
  const input = join(directory, 'plan.json')
  writeFileSync(input, JSON.stringify(plan()))
  const result = spawnSync(process.execPath, [resolve('scripts/infra-plan.mjs'), 'inspect'], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PLAN_JSON_PATH: input },
  })
  assert.equal(result.status, 0)
  assert.equal(
    JSON.parse(readFileSync(join(directory, '.local/deploy/policy.json'), 'utf8')).authority,
    'local-preview',
  )
})
