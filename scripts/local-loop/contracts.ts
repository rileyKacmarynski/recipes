import { z } from 'zod'

const text = z.string().trim().min(1)
export const roleSchema = z.enum([
  'implementation',
  'verification',
  'code-review',
  'security-review',
  'architecture-review',
])
export type Role = z.infer<typeof roleSchema>
const modelRefSchema = z.strictObject({
  providerID: z.string().regex(/^[^/#\s]+$/),
  modelID: z.string().regex(/^[^#\s]+$/),
  variant: z
    .string()
    .regex(/^[^#\s]+$/)
    .optional(),
})
export const modelSchema = z.union([
  modelRefSchema,
  text
    .regex(/^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/)
    .transform((value) => {
      const slash = value.indexOf('/')
      const [modelID, variant] = value.slice(slash + 1).split('#')
      return {
        providerID: value.slice(0, slash),
        modelID: modelID!,
        ...(variant ? { variant } : {}),
      }
    })
    .pipe(modelRefSchema),
])
export type Model = z.infer<typeof modelSchema>
export const billingSchema = z.enum(['chatgpt-subscription', 'metered'])
export type Billing = z.infer<typeof billingSchema>
export const budgetSchema = z.strictObject({
  maxEstimatedUsd: z.number().positive().max(100).default(2),
  maxTotalTokens: z.number().int().positive().max(2_000_000).default(100_000),
  maxInputTokensPerCall: z.number().int().positive().max(500_000).default(30_000),
  targetOutputTokensPerCall: z.number().int().positive().max(32_000).default(2_000),
  overheadTokensPerCall: z.number().int().min(1_000).max(32_000).default(4_096),
})
export const tokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  cache: z.object({ read: z.number().int().nonnegative(), write: z.number().int().nonnegative() }),
})
export type Tokens = z.infer<typeof tokensSchema>
export const measurementSchema = z.object({
  cost: z.number().nonnegative().finite(),
  tokens: tokensSchema,
})
export type Measurement = z.infer<typeof measurementSchema>
export type AgentCall = {
  billing: Billing
  session: string
  role: Role
  attempt: number
  model: Model
  startedAt: string
  finishedAt?: string
  estimatedInputTokens: number
  outputTargetTokens: number
  reservedTokens: number
  reservedUsd: number | null
  rates: { input: number; output: number } | null
  modelOutputLimit: number
  status: 'reserved' | 'completed' | 'unknown'
  observed?: Measurement
  accountedTokens?: number
  accountedUsd?: number | null
}
export type UsageReport = {
  billing: Billing
  policy: z.infer<typeof budgetSchema>
  calls: AgentCall[]
  sessions: { id: string; role: Role; model: Model }[]
  totals: {
    tokens: number
    estimatedUsd: number | null
    reportedUsd: number | null
    complete: boolean
  }
}
export const configSchema = z
  .strictObject({
    mode: z.enum(['implement', 'verify']).default('implement'),
    issue: text,
    workspace: text,
    contract: text,
    evidence: text,
    billing: billingSchema.default('chatgpt-subscription'),
    model: modelSchema.optional(),
    models: z
      .strictObject({
        implementation: modelSchema.optional(),
        verification: modelSchema.optional(),
        'code-review': modelSchema.optional(),
        'security-review': modelSchema.optional(),
        'architecture-review': modelSchema.optional(),
      })
      .default({}),
    budget: budgetSchema.prefault({}),
    writableFiles: z.array(text).default([]),
    contextFiles: z.array(text).default([]),
    scenarios: z.array(text).min(1),
    architectureReview: z.boolean().default(false),
    maxAttempts: z.number().int().min(1).max(5).default(2),
    wallClockMs: z.number().int().min(1_000).max(3_600_000).default(1_800_000),
    agentTimeoutMs: z.number().int().min(1_000).max(900_000).default(300_000),
    commandTimeoutMs: z.number().int().min(1_000).max(900_000).default(300_000),
  })
  .superRefine((config, context) => {
    for (const role of activeRoles(config))
      if (!config.models[role] && !config.model)
        context.addIssue({
          code: 'custom',
          message: `Select an explicit model for ${role} or supply model as the default`,
        })
    if (config.billing === 'chatgpt-subscription') {
      for (const model of [config.model, ...Object.values(config.models)])
        if (model && model.providerID !== 'openai')
          context.addIssue({
            code: 'custom',
            message:
              'ChatGPT subscription mode only permits openai/... models; AWS and paid API provider fallback are not authorized',
          })
    }
    if (config.mode === 'implement' && !config.writableFiles.length)
      context.addIssue({
        code: 'custom',
        message: 'Implementation mode requires explicitly approved writableFiles',
      })
    if (config.mode === 'verify' && config.writableFiles.length)
      context.addIssue({
        code: 'custom',
        message: 'Verify-only mode must not authorize writableFiles',
      })
  })
export type Config = z.infer<typeof configSchema>
export function activeRoles(config: {
  mode: 'implement' | 'verify'
  architectureReview: boolean
}): Role[] {
  return [
    ...(config.mode === 'implement' ? ['implementation' as const] : []),
    'code-review',
    'security-review',
    ...(config.architectureReview ? ['architecture-review' as const] : []),
    'verification',
  ]
}
export function modelForRole(config: Config, role: Role): Model {
  const selected = config.models[role] ?? config.model
  if (!selected) throw new Error(`No model selected for ${role}`)
  return selected
}

export const implementationSchema = z.strictObject({
  status: z.enum(['ready', 'needs-human']),
  rationale: text,
  files: z.array(z.strictObject({ path: text, content: z.string() })),
})
export const verifierSchema = z.strictObject({
  decision: z.enum(['approve', 'product-failure', 'uncertain', 'needs-human']),
  findings: z.array(text),
  coveredScenarios: z.array(text),
  repairRationale: z.string(),
})
export const reviewSchema = z.strictObject({
  decision: z.enum(['approve', 'product-failure', 'uncertain', 'needs-human']),
  findings: z.array(text),
  repairRationale: z.string(),
})
export const commandSchema = z.strictObject({
  name: text,
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  log: text,
  failure: z.enum(['product', 'setup']).optional(),
  termination: z.enum(['timeout', 'interrupted', 'spawn-error']).optional(),
  error: z.string().optional(),
})
export type Command = z.infer<typeof commandSchema>
export const candidateSchema = z.strictObject({
  path: text,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export type Candidate = z.infer<typeof candidateSchema>
export const uatSchema = z.object({
  outcome: z.enum(['passed', 'setup-error', 'expectation-failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  artifacts: z.object({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  scenarios: z.array(
    z.object({
      name: text,
      passed: z.boolean(),
      results: z
        .array(
          z.object({
            results: z
              .array(
                z.object({
                  status: z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']),
                }),
              )
              .min(1),
          }),
        )
        .min(1),
    }),
  ),
  cleanup: z.array(z.object({ resource: text, stopped: z.boolean() })).min(1),
  evidence: text,
})
export type Uat = z.infer<typeof uatSchema>
export type Outcome =
  | 'proposed-pass'
  | 'product-failure'
  | 'setup-failure'
  | 'verifier-uncertainty'
  | 'needs-human'
  | 'agent-error'
  | 'interrupted'
  | 'limit-exhausted'
  | 'protected-input-mutation'
  | 'budget-exhausted'
export type State =
  | 'implementation'
  | 'checks'
  | 'review'
  | 'build'
  | 'uat'
  | 'verification'
  | 'repair'
  | 'stopped'
export type Attempt = {
  number: number
  startedAt: string
  finishedAt?: string
  implementationSession?: string
  verifierSession?: string
  candidate?: Candidate
  commands: Command[]
  reviews: { role: Role; session: string; result?: z.infer<typeof reviewSchema> }[]
  outcome?: Outcome
  implementation?: z.infer<typeof implementationSchema>
  verifier?: z.infer<typeof verifierSchema>
  uat?: unknown
  repairRationale?: string
  evidence: string
}
export type Report = {
  mode: Config['mode']
  issue: string
  contract: { reference: string; snapshot: string; sha256: string }
  startedAt: string
  finishedAt?: string
  state: State
  transitions: { state: State; at: string }[]
  outcome?: Outcome
  reason?: string
  finalCandidate?: Candidate
  attempts: Attempt[]
  cleanupErrors: string[]
  agentUsage?: UsageReport
  approval: 'Human approval required; no authorization to ship'
}

export function sameSet(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((name) => actual.includes(name))
  )
}

export function completeUat(uat: Uat, candidate: Candidate, scenarios: string[]) {
  return (
    uat.artifacts.path === candidate.path &&
    uat.artifacts.sha256 === candidate.sha256 &&
    sameSet(
      uat.scenarios.map((scenario) => scenario.name),
      scenarios,
    ) &&
    uat.scenarios.every(
      (scenario) =>
        scenario.passed ===
        scenario.results.every((test) => test.results.at(-1)?.status === 'passed'),
    ) &&
    uat.cleanup.every((entry) => entry.stopped) &&
    uat.finishedAt >= uat.startedAt
  )
}
