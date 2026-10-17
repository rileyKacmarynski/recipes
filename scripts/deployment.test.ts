import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
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
import {
  inspectPlan,
  assertApprovalProtection,
  assertPlanningProtection,
} from './deployment-policy.ts'
import { createManifest, sealBundle, openBundle, sha256 } from './deployment-handoff.ts'
import type { Identity } from './deployment-handoff.ts'

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
const terraformVersion = '1.15.8'
const idQualifiedSubject =
  'repo:rileyKacmarynski@28719606/recipes@1324636296:environment:production'

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
    // This isolated fixture has no providers/backend and never contacts AWS or Cloudflare.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('TF_')),
    )
    const init = spawnSync(
      'terraform',
      [`-chdir=${directory}`, 'init', '-backend=false', '-input=false', '-no-color'],
      { env, encoding: 'utf8' },
    )
    assert.equal(init.status, 0, init.stderr)
    const plan = spawnSync(
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
    assert.equal(plan.status, 0, plan.stdout + plan.stderr)
    const shown = spawnSync(
      'terraform',
      [`-chdir=${directory}`, 'show', '-json', 'fixture.tfplan'],
      { env, encoding: 'utf8' },
    )
    assert.equal(shown.status, 0, shown.stderr)
    assert.equal(JSON.parse(shown.stdout).variables.github_oidc_subject.value, idQualifiedSubject)
  },
)
const plan = (resources: unknown[] = []) => ({
  format_version: '1.2',
  terraform_version: terraformVersion,
  resource_changes: resources,
})

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

test('security unknowns are visible but ordinary generated metadata is not review noise', () => {
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

test('destruction, Access/IAM edits, CAA changes and disabling deletion protection require review, not a policy rewrite', () => {
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

test('malformed and incomplete plans fail; policy reports never copy values or sensitive instance keys', () => {
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

const environment = () => ({
  can_admins_bypass: false,
  protection_rules: [
    {
      type: 'required_reviewers',
      prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { login: 'rileyKacmarynski' } }],
    },
  ],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
})
const branches = { branch_policies: [{ name: 'main', type: 'branch' }] }
test('approval checks enforce a real human gate, not exact reviewer membership or self-review settings', () => {
  assert.doesNotThrow(() => assertApprovalProtection(environment(), branches))
  assert.doesNotThrow(() =>
    assertApprovalProtection(
      {
        ...environment(),
        protection_rules: [
          {
            type: 'required_reviewers',
            prevent_self_review: true,
            reviewers: [
              { type: 'User', reviewer: { login: 'another-maintainer' } },
              { type: 'Team', reviewer: { id: 123 } },
            ],
          },
        ],
      },
      branches,
    ),
  )
  for (const input of [
    null,
    {},
    { ...environment(), can_admins_bypass: true },
    { ...environment(), protection_rules: [] },
    { ...environment(), protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
  ])
    assert.throws(() => assertApprovalProtection(input, branches))
})
test('both credential environments still restrict deployment to main', () => {
  assert.doesNotThrow(() => assertPlanningProtection(environment(), branches))
  for (const policies of [
    [],
    [{ name: '*' }],
    [{ name: 'main', type: 'tag' }],
    [{ name: 'main' }, { name: 'feature/*' }],
  ])
    assert.throws(() => assertPlanningProtection(environment(), { branch_policies: policies }))
})

const identity: Identity = {
  repository: 'rileyKacmarynski/recipes',
  runId: '123',
  runAttempt: '1',
  commit: 'a'.repeat(40),
  account: '123456789012',
  region: 'us-east-1',
  bucket: 'test-backend',
  backendKey: 'prod/terraform.tfstate',
  workspace: 'default',
  workspacePath: '/home/runner/work/recipes/recipes',
  terraformVersion,
  configurationSha256: 'b'.repeat(64),
  providerLockSha256: 'c'.repeat(64),
}
const files = {
  '.local/deploy/plan.tfplan': Buffer.from('SECRET_PLAN'),
  'packages/api/dist/api-lambda.zip': Buffer.from('MATCHING_API'),
  'packages/web/dist/index.html': Buffer.from('MATCHING_WEB'),
}
const now = new Date('2026-10-16T01:00:00Z')
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

test('the exact encrypted plan/builds remain usable through the one-day handoff window', () => {
  const manifest = createManifest(identity, files, now)
  const ciphertext = sealBundle(manifest, files, publicKey)
  assert.ok(!ciphertext.includes('SECRET_PLAN'))
  assert.deepEqual(
    openBundle(JSON.parse(ciphertext), privateKey, identity, new Date('2026-10-16T08:00:00Z'))
      .files,
    files,
  )
  for (const time of ['2026-10-16T00:59:59Z', '2026-10-17T01:00:00Z'])
    assert.throws(() => openBundle(JSON.parse(ciphertext), privateKey, identity, new Date(time)))
})
test('reruns can produce new handoffs, but cannot reuse a different attempt, commit, target or artifact', () => {
  const retried = {
    ...identity,
    runAttempt: '2',
    region: 'eu-west-1',
    backendKey: 'other/state',
    workspace: 'other',
  }
  const ciphertext = JSON.parse(sealBundle(createManifest(retried, files, now), files, publicKey))
  assert.deepEqual(openBundle(ciphertext, privateKey, retried, now).files, files)
  for (const override of [
    { runAttempt: '1' },
    { runId: '124' },
    { commit: 'd'.repeat(40) },
    { account: '999999999999' },
    { bucket: 'wrong' },
    { workspace: 'wrong' },
    { configurationSha256: 'd'.repeat(64) },
    { providerLockSha256: 'e'.repeat(64) },
  ])
    assert.throws(() => openBundle(ciphertext, privateKey, { ...retried, ...override }, now))
})
test('tampering, missing builds, unsafe paths and changed artifact bytes still fail closed', () => {
  const manifest = createManifest(identity, files, now)
  const ciphertext = JSON.parse(sealBundle(manifest, files, publicKey))
  assert.throws(() =>
    openBundle(
      { ...ciphertext, tag: Buffer.alloc(16).toString('base64') },
      privateKey,
      identity,
      now,
    ),
  )
  assert.throws(() => createManifest(identity, { ...files, '../escape': Buffer.from('bad') }, now))
  assert.throws(() => createManifest(identity, {}, now))
  assert.throws(() =>
    createManifest(
      identity,
      { ...files, 'packages/web/dist/../../escape': Buffer.from('bad') },
      now,
    ),
  )
  const assets = { ...files, 'packages/web/dist/assets/logo @2x.svg': Buffer.from('<svg/>') }
  assert.deepEqual(
    openBundle(
      JSON.parse(sealBundle(createManifest(identity, assets, now), assets, publicKey)),
      privateKey,
      identity,
      now,
    ).files,
    assets,
  )
  assert.throws(() =>
    openBundle(
      JSON.parse(
        sealBundle(
          manifest,
          { ...files, 'packages/api/dist/api-lambda.zip': Buffer.from('OTHER_COMMIT') },
          publicKey,
        ),
      ),
      privateKey,
      identity,
      now,
    ),
  )
})
test('local review refuses obsolete Actions download/decrypt inputs', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-review-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env = {
    ...process.env,
    REVIEW_HANDOFF_PATH: '/not-a-local-preview/handoff.json',
  }
  const result = spawnSync(process.execPath, [resolve('scripts/infra-plan.mjs'), 'review'], {
    cwd: directory,
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Actions plans are reviewed in GitHub/)
  assert.equal(result.stdout, '')
  assert.ok(!result.stdout.includes('SECRET_PLAN'))
})
test('Actions handles Terraform exit codes without leaking diagnostics or falling back to apply', (t) => {
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
          GITHUB_REPOSITORY: identity.repository,
          AWS_REGION: identity.region,
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

test('a rerun plans and seals builds for its pinned commit without requiring latest main or fixed app URLs', (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'recipes-authoritative-test-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const path of ['bin', 'packages/api/dist', 'infra/terraform/prod/.terraform'])
    mkdirSync(join(directory, path), { recursive: true })
  writeFileSync(
    join(directory, 'packages/api/dist/api-lambda.zip'),
    files['packages/api/dist/api-lambda.zip'],
  )
  writeFileSync(join(directory, 'infra/terraform/prod/main.tf'), '# fixture')
  writeFileSync(join(directory, 'infra/terraform/prod/.terraform.lock.hcl'), '# pinned fixture')
  writeFileSync(
    join(directory, 'infra/terraform/prod/.terraform/terraform.tfstate'),
    JSON.stringify({
      backend: {
        type: 's3',
        config: { bucket: identity.bucket, key: identity.backendKey, region: identity.region },
      },
    }),
  )
  const executable = (name: string, body: string) =>
    writeFileSync(join(directory, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o700 })
  executable(
    'git',
    `case "$*" in 'rev-parse HEAD') printf '${identity.commit}' ;; 'ls-files infra/terraform') printf 'infra/terraform/prod/main.tf\\ninfra/terraform/prod/.terraform.lock.hcl' ;; *) exit 1 ;; esac`,
  )
  executable('aws', `printf '${JSON.stringify({ Account: identity.account })}'`)
  const savedPlan = {
    ...plan(),
    variables: {
      api_lambda_zip_path: { value: join(directory, 'packages/api/dist/api-lambda.zip') },
      api_lambda_source_code_hash: {
        value: Buffer.from(sha256(files['packages/api/dist/api-lambda.zip']), 'hex').toString(
          'base64',
        ),
      },
      aws_profile: { value: null },
      aws_region: { value: identity.region },
    },
    planned_values: { outputs: { api_url: { value: 'https://new-api.example' } } },
  }
  const planFile = join(directory, 'plan-fixture.json')
  writeFileSync(planFile, JSON.stringify(savedPlan))
  executable(
    'terraform',
    `case "$*" in
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
  const preload = join(directory, 'github-fixture.mjs')
  writeFileSync(
    preload,
    `globalThis.fetch = async (url) => {
    if (String(url).includes('/git/ref/')) throw new Error('Do not require main HEAD');
    const branch = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
    const value = String(url).includes('deployment-branch-policies') ? { branch_policies: [{ name: 'main', type: 'branch' }] }
      : { ...branch, can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { login: 'another-maintainer' } }] }] };
    return Response.json(value);
  };`,
  )
  const result = spawnSync(
    process.execPath,
    ['--import', preload, resolve('scripts/production-deployment.ts'), 'plan'],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
        PLAN_FIXTURE: planFile,
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REPOSITORY: identity.repository,
        GITHUB_WORKSPACE: directory,
        GITHUB_RUN_ID: identity.runId,
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_SHA: identity.commit,
        GH_TOKEN: 'private',
        GITHUB_OUTPUT: join(directory, 'github-output'),
        GITHUB_STEP_SUMMARY: join(directory, 'summary'),
        AWS_REGION: identity.region,
        AWS_EXPECTED_ACCOUNT_ID: identity.account,
        TF_WORKSPACE: identity.workspace,
        TERRAFORM_VERSION: terraformVersion,
        TF_BACKEND_BUCKET: identity.bucket,
        TF_VAR_terraform_state_bucket: identity.bucket,
        TF_VAR_github_oidc_subject: idQualifiedSubject,
        DEPLOY_PLAN_PUBLIC_KEY: publicKey,
        CLOUDFLARE_API_TOKEN: 'private',
        TF_VAR_access_allowed_email: 'private',
        TF_VAR_cloudflare_account_id: 'private',
        TF_VAR_cloudflare_access_team_domain: 'private',
        TF_VAR_cloudflare_zone_id: 'private',
      },
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(join(directory, '.local/deploy/manifest.json'), 'utf8'))
  const restored = openBundle(
    JSON.parse(readFileSync(join(directory, '.local/deploy/handoff.encrypted.json'), 'utf8')),
    privateKey,
    manifest.identity,
    new Date(),
  )
  assert.equal(manifest.identity.runAttempt, '2')
  assert.equal(
    restored.files['packages/web/dist/index.html']!.toString(),
    'https://new-api.example',
  )
  assert.equal(restored.files['.local/deploy/plan.tfplan']!.toString(), 'PRIVATE_PLAN')
})
test('local calls and feature refs are refused; local inspection is never authoritative', (t) => {
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
