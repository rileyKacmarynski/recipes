import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const actions = new Set(['no-op', 'read', 'create', 'update', 'delete', 'forget', 'create-forget'])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const flagged = (value) =>
  value === true || ((object(value) || Array.isArray(value)) && Object.values(value).some(flagged))

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
    const findings = []
    const changed = change.actions.some((action) => action !== 'no-op' && action !== 'read')
    if (
      change.actions.includes('delete') ||
      change.actions.includes('forget') ||
      change.actions.includes('create-forget')
    ) {
      findings.push('Destroy, replacement, or state removal requires explicit review.')
    }
    if (changed && typeof resource.type === 'string' && resource.type.includes('access')) {
      findings.push('Access policy/application/credential change requires review.')
    }
    if (resource.type === 'aws_apigatewayv2_api' && !change.actions.includes('delete')) {
      if (after.disable_execute_api_endpoint !== true)
        findings.push('API Gateway default endpoint is enabled or unknown.')
    }
    if (
      resource.type === 'cloudflare_record' &&
      ['A', 'AAAA', 'CNAME'].includes(after.type) &&
      after.proxied !== true
    ) {
      findings.push('Address/alias DNS record is unproxied or its proxy setting is unknown.')
    }
    if (resource.type === 'aws_db_instance' && after.publicly_accessible === true) {
      findings.push('Database instance is publicly accessible.')
    }
    if (changed && flagged(change.after_unknown))
      findings.push(
        'Changed resource has values only known after apply; review remains incomplete.',
      )
    return {
      address: addressForReport(resource.address),
      actions: change.actions,
      changedAttributes: fields,
      containsSensitiveAttributes:
        flagged(change.before_sensitive) || flagged(change.after_sensitive),
      findings,
    }
  })
  return {
    schemaVersion: 1,
    applied: false,
    outputs,
    actionableResources: resources.filter((resource) =>
      resource.actions.some((action) => action !== 'no-op' && action !== 'read'),
    ).length,
    resources: resources.filter(
      (resource) =>
        resource.findings.length ||
        resource.actions.some((action) => action !== 'no-op' && action !== 'read'),
    ),
    limitations: [
      'This is a value-redacted local preview, not approval, a full security policy check, or proof of runtime behavior.',
      'All attribute/output values, instance keys, provider diagnostics, and credentials are omitted.',
      'Inspect private plan/log files yourself if more detail is needed; do not share them with an agent.',
      'Reviewed pipeline planning/apply and comprehensive policy inspection remain work under issue #14.',
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
      ...resource.findings.map((finding) => `- REVIEW: ${finding}`),
      '',
    ]),
    '## Changed outputs (values omitted)',
    ...report.outputs.map((output) => `- ${output.name}: ${output.actions.join(', ')}`),
    ...(report.outputs.length ? [] : ['None.']),
    '',
    '## Limitations',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
  ].join('\n')
}

function main([command, input, output, root]) {
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
  } else if (command === 'account') {
    const identity = JSON.parse(readFileSync(input, 'utf8'))
    if (typeof identity.Account !== 'string' || !/^\d{12}$/.test(identity.Account))
      throw new Error('Invalid AWS identity')
    process.stdout.write(identity.Account)
  } else if (command === 'report') {
    const report = summarizePlan(JSON.parse(readFileSync(input, 'utf8')))
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
  } catch {
    // Never print untrusted JSON, Terraform diagnostics, or secret-bearing parser errors.
    console.error(
      'Plan helper failed: input was missing, malformed, or unsupported. No approval report can be trusted.',
    )
    process.exitCode = 1
  }
}
