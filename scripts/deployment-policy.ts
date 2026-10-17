import { z } from 'zod'

const attributes = z.record(z.string(), z.unknown())
export const planSchema = z.object({
  format_version: z.string().regex(/^1\./),
  terraform_version: z.string(),
  errored: z.literal(false).optional(),
  complete: z.literal(true).optional(),
  resource_changes: z
    .array(
      z.object({
        address: z.string(),
        mode: z.enum(['managed', 'data']),
        type: z.string().regex(/^[a-z0-9_]+$/),
        change: z.object({
          actions: z
            .array(
              z.enum(['no-op', 'read', 'create', 'update', 'delete', 'forget', 'create-forget']),
            )
            .min(1),
          before: attributes.nullish(),
          after: attributes.nullish(),
          after_unknown: attributes.optional(),
        }),
      }),
    )
    .default([]),
})
export type Plan = z.infer<typeof planSchema>
export type Finding = {
  address: string
  rule: string
  severity: 'violation' | 'review' | 'unresolved'
}
export function safeAddress(address: string) {
  const value = address.replace(/\["(?:[^"\\]|\\.)*"\]/g, '[*]')
  return /^[A-Za-z0-9_.[\]*-]+$/.test(value) ? value : '[redacted address]'
}
const flagged = (value: unknown): boolean =>
  value === true ||
  (typeof value === 'object' && value !== null && Object.values(value).some(flagged))

// Specific exposure checks block. Architectural changes remain visible for human review.
// No resource inventory, hostname list, or generic "computed value" warnings.
export function evaluatePlan(plan: Plan) {
  const findings: Finding[] = []
  const resources = plan.resource_changes.filter((resource) => resource.mode === 'managed')
  for (const { address, type, change } of resources) {
    const add = (rule: string, severity: Finding['severity']) =>
      findings.push({ address: safeAddress(address), rule, severity })
    const after = change.after ?? {}
    const before = change.before ?? {}
    const unknown = change.after_unknown ?? {}
    const changed = change.actions.some((action) => !['no-op', 'read'].includes(action))
    if (change.actions.some((action) => ['delete', 'forget', 'create-forget'].includes(action)))
      add('destruction-or-replacement', 'review')
    if (changed && type.includes('access')) add('access-change', 'review')
    if (changed && type.startsWith('aws_iam_')) add('iam-change', 'review')
    if (changed && type === 'cloudflare_record')
      add(after.type === 'CAA' || before.type === 'CAA' ? 'caa-change' : 'dns-change', 'review')
    if (
      changed &&
      ['domain_name', 'domain', 'subject_alternative_names', 'aliases', 'destinations'].some(
        (field) =>
          JSON.stringify(before[field]) !== JSON.stringify(after[field]) || flagged(unknown[field]),
      )
    )
      add('hostname-or-routing-change', 'review')
    if (
      change.actions.some((action) => ['delete', 'forget'].includes(action)) &&
      !change.actions.includes('create')
    )
      continue
    const requireValue = (field: string, expected: boolean, rule: string) => {
      if (flagged(unknown[field]) || after[field] === undefined) add(rule, 'unresolved')
      else if (after[field] !== expected) add(rule, 'violation')
    }
    if (type === 'aws_apigatewayv2_api')
      requireValue('disable_execute_api_endpoint', true, 'api-default-endpoint')
    if (['aws_db_instance', 'aws_rds_cluster_instance'].includes(type))
      requireValue('publicly_accessible', false, 'public-database')
    if (type === 'aws_rds_cluster') {
      requireValue('storage_encrypted', true, 'database-encryption')
      if (changed && after.deletion_protection === false && before.deletion_protection !== false)
        add('database-deletion-protection-change', 'review')
      if (flagged(unknown.deletion_protection))
        add('database-deletion-protection-change', 'unresolved')
    }
  }
  return {
    schemaVersion: 1,
    policyPassed: !findings.some((finding) => finding.severity === 'violation'),
    resources: resources.map((resource) => ({
      address: safeAddress(resource.address),
      actions: resource.change.actions,
    })),
    findings,
    disclaimer:
      'No known exposure violations is not proof of correctness. Review changes locally or in the PR; runtime behavior is checked after deployment.',
  }
}
export function inspectPlan(input: unknown) {
  return evaluatePlan(planSchema.parse(input))
}
export function renderPolicyReport(
  report: ReturnType<typeof inspectPlan> & { previewRun?: string; planSha256?: string },
  authority: 'actions-saved-plan' | 'local-preview',
) {
  return [
    `# ${authority === 'actions-saved-plan' ? 'Authoritative Actions saved plan' : 'Local preview — not the Actions plan'}`,
    ...(report.previewRun
      ? [`Local preview: ${report.previewRun}`, `Saved plan SHA-256: ${report.planSha256}`]
      : []),
    `Policy: ${report.policyPassed ? 'no known exposure violations' : 'BLOCKED'}.`,
    report.disclaimer,
    ...report.resources.map((resource) => `- ${resource.address}: ${resource.actions.join(', ')}`),
    ...report.findings.map(
      (finding) => `- ${finding.severity.toUpperCase()}: ${finding.address}: ${finding.rule}`,
    ),
    '',
  ].join('\n')
}
