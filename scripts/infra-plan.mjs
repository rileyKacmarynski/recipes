import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
  openSync,
  closeSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { inspectPlan, renderPolicyReport } from './deployment-policy.ts'

const actions = new Set(['no-op', 'read', 'create', 'update', 'delete', 'forget', 'create-forget'])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const flagged = (value) =>
  value === true || ((object(value) || Array.isArray(value)) && Object.values(value).some(flagged))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

class InspectionError extends Error {}

function latestPreview() {
  const base = resolve('.local/infra-plan')
  const runs = existsSync(base)
    ? readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z-[A-Za-z0-9]+$/.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          created: statSync(resolve(base, entry.name)).birthtimeMs,
        }))
        .sort(
          (a, b) =>
            b.name.slice(0, 16).localeCompare(a.name.slice(0, 16)) ||
            b.created - a.created ||
            b.name.localeCompare(a.name),
        )
    : []
  if (!runs.length)
    throw new InspectionError('No local preview found. Run pnpm infra:preview first.')
  const directory = resolve(base, runs[0].name)
  const plan = resolve(directory, 'plan.tfplan')
  if (
    !existsSync(plan) ||
    !lstatSync(plan).isFile() ||
    !existsSync(resolve(directory, 'report.json')) ||
    !existsSync(resolve(directory, 'report.md'))
  )
    throw new InspectionError(
      `Newest preview (${runs[0].name}) did not finish with a saved plan and reports. Run pnpm infra:preview again; no older plan was selected.`,
    )
  return { directory, plan, name: runs[0].name }
}

function showSavedPlan(preview, privateTerminal = false) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('TF_CLI_ARGS') && !name.startsWith('TF_LOG'),
    ),
  )
  const diagnostics = openSync(resolve(preview.directory, 'inspect.private.log'), 'w', 0o600)
  try {
    return execFileSync(
      'terraform',
      [
        `-chdir=${resolve('infra/terraform/prod')}`,
        'show',
        privateTerminal ? '-no-color' : '-json',
        preview.plan,
      ],
      {
        env,
        encoding: 'utf8',
        stdio: ['ignore', privateTerminal ? 'inherit' : 'pipe', diagnostics],
        maxBuffer: 64 * 1024 * 1024,
      },
    )
  } catch {
    throw new InspectionError(
      'Could not read the newest saved plan. Check Terraform/provider installation and the private inspect.private.log in that preview directory. No older plan was selected.',
    )
  } finally {
    closeSync(diagnostics)
  }
}

function addressForReport(address) {
  if (typeof address !== 'string') throw new Error('Invalid plan')
  // Instance keys can contain identifying data; keep only the resource address shape.
  const redacted = address.replace(/\["(?:[^"\\]|\\.)*"\]/g, '[*]')
  return /^[A-Za-z0-9_.[\]*-]+$/.test(redacted) ? redacted : '[redacted address]'
}

export function summarizePlan(plan) {
  if (
    !object(plan) ||
    typeof plan.format_version !== 'string' ||
    !plan.format_version.startsWith('1.')
  ) {
    throw new Error('Invalid or unsupported Terraform plan')
  }
  if (plan.errored === true || plan.complete === false) throw new Error('Incomplete Terraform plan')
  const changes = plan.resource_changes ?? []
  if (!Array.isArray(changes)) throw new Error('Invalid plan changes')
  const outputChanges = plan.output_changes ?? {}
  if (!object(outputChanges)) throw new Error('Invalid output changes')
  const outputs = Object.entries(outputChanges).flatMap(([name, change]) => {
    if (
      !object(change) ||
      !Array.isArray(change.actions) ||
      change.actions.length === 0 ||
      change.actions.some((action) => !actions.has(action))
    ) {
      throw new Error('Invalid output change')
    }
    if (change.actions.every((action) => action === 'no-op' || action === 'read')) return []
    return [
      {
        name: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : '[redacted output name]',
        actions: change.actions,
      },
    ]
  })

  const resources = changes.map((resource) => {
    if (
      !object(resource) ||
      typeof resource.type !== 'string' ||
      !/^[A-Za-z0-9_]+$/.test(resource.type) ||
      !object(resource.change) ||
      !Array.isArray(resource.change.actions) ||
      resource.change.actions.length === 0 ||
      resource.change.actions.some((action) => !actions.has(action))
    ) {
      throw new Error('Invalid resource change')
    }
    const { change } = resource
    const before = object(change.before) ? change.before : {}
    const after = object(change.after) ? change.after : {}
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(
        (key) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
          JSON.stringify(before[key]) !== JSON.stringify(after[key]),
      )
      .sort()
    return {
      address: addressForReport(resource.address),
      actions: change.actions,
      changedAttributes: fields,
      containsSensitiveAttributes:
        flagged(change.before_sensitive) || flagged(change.after_sensitive),
    }
  })
  return {
    schemaVersion: 1,
    applied: false,
    outputs,
    actionableResources: resources.filter((resource) =>
      resource.actions.some((action) => action !== 'no-op' && action !== 'read'),
    ).length,
    resources: resources.filter((resource) =>
      resource.actions.some((action) => action !== 'no-op' && action !== 'read'),
    ),
    limitations: [
      'This is a value-redacted local preview, not approval or proof of runtime behavior.',
      'All attribute/output values, instance keys, provider diagnostics, and credentials are omitted.',
      'Inspect private plan/log files yourself if more detail is needed; do not share them with an agent.',
      'Only the separately generated authoritative Actions plan can be approved for deployment.',
    ],
  }
}

export function renderReport(report) {
  return [
    '# Production Terraform plan preview',
    '',
    `Actionable resources: ${report.actionableResources}. Nothing was applied.`,
    ...(report.sourceCommit
      ? [
          `Source commit: ${report.sourceCommit}; uncommitted changes: ${report.sourceDirty ? 'yes' : 'no'}.`,
          `Saved plan SHA-256: ${report.planSha256}`,
        ]
      : []),
    '',
    ...report.resources.flatMap((resource) => [
      `## ${resource.address}`,
      `Actions: ${resource.actions.join(', ')}`,
      `Changed top-level attributes: ${resource.changedAttributes.join(', ') || 'none'}`,
      `Contains sensitive attributes: ${resource.containsSensitiveAttributes ? 'yes' : 'no'}`,
      '',
    ]),
    '## Changed outputs (values omitted)',
    ...report.outputs.map((output) => `- ${output.name}: ${output.actions.join(', ')}`),
    ...(report.outputs.length ? [] : ['None.']),
    '',
    ...(report.policy
      ? [
          '## Structured plan policy',
          `Known guardrails: ${report.policy.policyPassed ? 'no known violations' : 'BLOCKED'}.`,
          report.policy.disclaimer,
          ...report.policy.findings.map(
            (finding) => `- ${finding.severity.toUpperCase()}: ${finding.address}: ${finding.rule}`,
          ),
          '',
        ]
      : []),
    '## Limitations',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
  ].join('\n')
}

function main([command, input, output, root]) {
  process.umask(0o077)
  if (command === 'artifact-inputs') {
    const path = resolve(input)
    console.log(
      JSON.stringify({
        api_lambda_zip_path: path,
        api_lambda_source_code_hash: createHash('sha256')
          .update(readFileSync(path))
          .digest('base64'),
      }),
    )
  } else if (command === 'backend-value') {
    if (!['bucket', 'profile', 'key', 'region'].includes(output))
      throw new Error('Invalid backend field')
    let value = ''
    try {
      const state = JSON.parse(readFileSync(input, 'utf8'))
      if (state.backend?.type === 's3') value = state.backend?.config?.[output] ?? ''
    } catch {
      /* A first run has no initialized backend; the wizard will prompt. */
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value))
      throw new Error('Invalid backend setting')
    process.stdout.write(value)
  } else if (command === 'provider-inputs') {
    const values = JSON.parse(readFileSync(input, 'utf8'))
    const profile = process.env.TF_PROVIDER_PROFILE || null
    if (profile !== null && /[\r\n]/.test(profile)) throw new Error('Invalid provider profile')
    const region = process.env.AWS_EXPECTED_REGION
    if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region))
      throw new Error('Invalid provider region')
    writeFileSync(input, JSON.stringify({ ...values, aws_profile: profile, aws_region: region }), {
      mode: 0o600,
    })
  } else if (command === 'account') {
    const identity = JSON.parse(readFileSync(input, 'utf8'))
    if (typeof identity.Account !== 'string' || !/^\d{12}$/.test(identity.Account))
      throw new Error('Invalid AWS identity')
    process.stdout.write(identity.Account)
  } else if (command === 'inspect') {
    const explicitJson = process.env.PLAN_JSON_PATH
    const preview = explicitJson ? null : latestPreview()
    const report = {
      ...inspectPlan(
        JSON.parse(preview ? showSavedPlan(preview) : readFileSync(explicitJson, 'utf8')),
      ),
      authority: 'local-preview',
      ...(preview
        ? { previewRun: preview.name, planSha256: sha256(readFileSync(preview.plan)) }
        : {}),
    }
    const directory = preview?.directory ?? resolve('.local/deploy')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(resolve(directory, 'policy.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    })
    writeFileSync(resolve(directory, 'policy.md'), renderPolicyReport(report, report.authority), {
      mode: 0o600,
    })
    if (explicitJson)
      console.log('Using explicit PLAN_JSON_PATH input, not automatic newest-preview selection.\n')
    console.log(renderPolicyReport(report, report.authority))
    console.log(
      `Redacted reports: ${resolve(directory, 'policy.md')} and ${resolve(directory, 'policy.json')}`,
    )
    if (!report.policyPassed) process.exitCode = 1
  } else if (command === 'review') {
    if (Object.keys(process.env).some((name) => name.startsWith('REVIEW_')))
      throw new InspectionError(
        'Actions plans are reviewed in GitHub, not downloaded for local review. Remove obsolete REVIEW_* inputs; pnpm infra:review only opens the newest local preview.',
      )
    const preview = latestPreview()
    if (!process.stdout.isTTY)
      throw new InspectionError(
        'Full plan review can expose sensitive values. Run pnpm infra:review yourself in a private terminal, or use pnpm infra:inspect for redacted output.',
      )
    console.log(
      `Private review of newest local preview: ${preview.name}\nThis may contain secrets. Do not share raw output with an agent. Nothing is approved or applied.\n`,
    )
    showSavedPlan(preview, true)
  } else if (command === 'report') {
    const plan = JSON.parse(readFileSync(input, 'utf8'))
    const report = summarizePlan(plan)
    report.authority = 'local-preview'
    report.policy = inspectPlan(plan)
    report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    report.sourceDirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
        .length > 0
    report.planSha256 = createHash('sha256')
      .update(readFileSync(resolve(output, 'plan.tfplan')))
      .digest('hex')
    writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    })
    writeFileSync(resolve(output, 'report.md'), renderReport(report), { mode: 0o600 })
  } else {
    throw new Error('Unknown command')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    // Never print untrusted JSON, Terraform diagnostics, or secret-bearing parser errors.
    console.error(
      error instanceof InspectionError
        ? error.message
        : 'Plan helper failed: input was missing, malformed, or unsupported. No approval report can be trusted.',
    )
    process.exitCode = 1
  }
}
