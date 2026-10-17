import { execFileSync, spawnSync } from 'node:child_process'
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
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import {
  inspectPlan,
  assertApprovalProtection,
  assertPlanningProtection,
  renderPolicyReport,
} from './deployment-policy.ts'
import {
  createManifest,
  sealBundle,
  openBundle,
  identitySchema,
  sha256,
  assertFreshManifest,
} from './deployment-handoff.ts'

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
  const descriptor = openSync(resolve(directory, log), 'w', 0o600)
  try {
    const result = spawnSync('terraform', [`-chdir=${tf}`, ...args], {
      stdio: ['ignore', descriptor, descriptor],
    })
    if (result.error || (result.status !== 0 && !(detailedExit && result.status === 2)))
      throw new DeploymentBlocked('Terraform command failed; diagnostics remain private')
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

async function github(path: string) {
  const response = await fetch(`https://api.github.com/repos/${env('GITHUB_REPOSITORY')}/${path}`, {
    headers: {
      Authorization: `Bearer ${env('GH_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new DeploymentBlocked(`GitHub approval checks unavailable (HTTP ${response.status})`)
  return response.json() as Promise<unknown>
}
async function approval() {
  phase = 'github-environment-api'
  const [environment, branches, planningEnvironment, planningBranches] = await Promise.all([
    github('environments/production'),
    github('environments/production/deployment-branch-policies?per_page=100'),
    github('environments/production-plan'),
    github('environments/production-plan/deployment-branch-policies?per_page=100'),
  ])
  phase = 'production-required-reviewer-and-branch-protection'
  assertApprovalProtection(environment, branches)
  phase = 'planning-main-only-protection'
  assertPlanningProtection(planningEnvironment, planningBranches)
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
  if (account !== env('AWS_EXPECTED_ACCOUNT_ID'))
    throw new DeploymentBlocked('Unexpected AWS account')
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
  if (command === 'approval') return approval()
  if (command === 'init') {
    env('AWS_EXPECTED_ACCOUNT_ID')
    const bucket = env('TF_BACKEND_BUCKET')
    await approval()
    phase = 'terraform-format-initialize-and-validate'
    terraform(['fmt', '-check', '-recursive', '../'], 'fmt.private.log')
    terraform(
      ['init', '-input=false', '-lockfile=readonly', `-backend-config=bucket=${bucket}`],
      'init.private.log',
    )
    terraform(['validate', '-no-color'], 'validate.private.log')
    identity()
  } else if (command === 'plan') {
    await approval()
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
    const files = {
      ...webFiles(),
      '.local/deploy/plan.tfplan': readFileSync(resolve(directory, 'plan.tfplan')),
      'packages/api/dist/api-lambda.zip': readFileSync('packages/api/dist/api-lambda.zip'),
    }
    const manifest = createManifest(identity(), files, new Date())
    phase = 'encrypted-handoff-public-key'
    const ciphertext = sealBundle(manifest, files, env('DEPLOY_PLAN_PUBLIC_KEY'))
    writeFileSync(resolve(directory, 'handoff.encrypted.json'), ciphertext, { mode: 0o600 })
    // Safe identity/checksums only. The ciphertext hash is a job output bound to this run.
    write('manifest.json', manifest)
    writeFileSync(env('GITHUB_OUTPUT'), `handoff_sha256=${sha256(ciphertext)}\n`, { flag: 'a' })
    writeFileSync(
      env('GITHUB_STEP_SUMMARY'),
      readFileSync(resolve(directory, 'policy.md')) +
        `\nCommit: ${manifest.identity.commit}\nRun: ${manifest.identity.runId}\nExpires: ${manifest.expiresAt}\nSaved plan SHA-256: ${manifest.files['.local/deploy/plan.tfplan']}\nEncrypted handoff SHA-256: ${sha256(ciphertext)}\n`,
      { flag: 'a' },
    )
  } else if (command === 'open') {
    await approval()
    phase = 'same-run-handoff-checksum'
    const ciphertext = readFileSync(resolve(directory, 'handoff.encrypted.json'))
    if (sha256(ciphertext) !== env('EXPECTED_HANDOFF_SHA256'))
      throw new DeploymentBlocked('Wrong workflow artifact checksum')
    const expected = identity()
    phase = 'encrypted-handoff-identity-expiry-and-integrity'
    const bundle = openBundle(
      JSON.parse(ciphertext.toString()),
      env('DEPLOY_PLAN_PRIVATE_KEY'),
      expected,
      new Date(),
    )
    for (const [path, data] of Object.entries(bundle.files)) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true, mode: 0o700 })
      writeFileSync(resolve(root, path), data, { mode: 0o600 })
    }
    write('manifest.json', bundle.manifest)
    // This re-inspects the saved plan; it never creates a replacement plan.
    const plan: unknown = JSON.parse(
      run('terraform', [`-chdir=${tf}`, 'show', '-json', resolve(directory, 'plan.tfplan')]),
    )
    assertArtifactInputs(plan)
    const report = policy(plan)
    if (!report.policyPassed) throw new DeploymentBlocked('Saved plan violates exposure policy')
  } else if (command === 'confirm-apply') {
    await approval()
    const expected = identity()
    phase = 'immediate-pre-apply-freshness-and-integrity'
    const manifest = assertFreshManifest(
      json(resolve(directory, 'manifest.json')),
      expected,
      new Date(),
    )
    for (const [path, digest] of Object.entries(manifest.files))
      if (sha256(readFileSync(path)) !== digest)
        throw new DeploymentBlocked('Artifact changed after review')
    const expectedWebFiles = Object.keys(manifest.files)
      .filter((path) => path.startsWith('packages/web/dist/'))
      .sort()
    if (JSON.stringify(Object.keys(webFiles()).sort()) !== JSON.stringify(expectedWebFiles))
      throw new DeploymentBlocked('Web artifact files changed after review')
  } else throw new DeploymentBlocked('Unknown deployment command')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    // Parser, provider, crypto and HTTP errors may contain sensitive input.
    const detail =
      error instanceof DeploymentBlocked
        ? error.message
        : 'Required command, schema, expiry or integrity validation failed; sensitive diagnostics omitted.'
    console.error(`Deployment blocked at ${phase}: ${detail}. No fallback plan is permitted.`)
    try {
      write('prerequisite-failure.json', { schemaVersion: 1, success: false, phase, detail })
    } catch {
      /* The safe log remains available if local storage failed. */
    }
    process.exitCode = 1
  })
