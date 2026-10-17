import { z } from 'zod'
import { LoopStop } from './coordinator.ts'
import {
  measurementSchema,
  type AgentCall,
  type Billing,
  type Config,
  type Measurement,
  type Model,
  type Role,
  type Tokens,
  type UsageReport,
} from './contracts.ts'

// Deliberately strip provider settings, headers and bodies: catalog entries can contain secrets.
export const catalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      providerID: z.string(),
      enabled: z.boolean(),
      variants: z.array(z.object({ id: z.string() })),
      limit: z.object({
        context: z.number().int().positive(),
        input: z.number().int().positive().optional(),
        output: z.number().int().positive(),
      }),
      cost: z.array(
        z.object({
          input: z.number().finite().nonnegative(),
          output: z.number().finite().nonnegative(),
          cache: z.object({
            read: z.number().finite().nonnegative(),
            write: z.number().finite().nonnegative(),
          }),
        }),
      ),
    }),
  ),
})
export type CatalogModel = z.infer<typeof catalogSchema>['data'][number]
export const zeroMeasurement = (): Measurement => ({
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
export function countTokens(tokens: Tokens) {
  // Conservative across providers: output/reasoning and input/cache may overlap.
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
export function estimateInput(text: string, history: number, overhead: number) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3) + history + overhead
}
export function selectCatalogModel(
  catalog: CatalogModel[],
  model: Model,
  billing: Billing = 'metered',
) {
  const entry = catalog.find(
    (item) => item.id === model.modelID && item.providerID === model.providerID && item.enabled,
  )
  if (!entry || (model.variant && !entry.variants.some((variant) => variant.id === model.variant)))
    throw new LoopStop(
      'setup-failure',
      `Configured model/variant is unavailable: ${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ''}; no fallback`,
    )
  if (billing === 'chatgpt-subscription' && model.providerID !== 'openai')
    throw new LoopStop('setup-failure', 'ChatGPT subscription mode refuses non-OpenAI providers')
  if (billing === 'metered' && !entry.cost.length)
    throw new LoopStop(
      'setup-failure',
      `Pricing metadata is missing for ${model.providerID}/${model.modelID}; refusing an unpriced model call`,
    )
  return entry
}
export function usageTotals(calls: AgentCall[], billing: Billing = calls[0]?.billing ?? 'metered') {
  return {
    tokens: calls.reduce(
      (sum, call) =>
        sum +
        (call.status === 'completed'
          ? call.accountedTokens!
          : Math.max(call.accountedTokens ?? 0, call.reservedTokens)),
      0,
    ),
    estimatedUsd:
      billing === 'chatgpt-subscription'
        ? null
        : calls.reduce(
            (sum, call) =>
              sum +
              (call.status === 'completed'
                ? call.accountedUsd!
                : Math.max(call.accountedUsd ?? 0, call.reservedUsd!)),
            0,
          ),
    reportedUsd:
      billing === 'chatgpt-subscription'
        ? null
        : calls.reduce((sum, call) => sum + (call.observed?.cost ?? 0), 0),
    complete: calls.every((call) => call.status === 'completed'),
  }
}
export function reserveCall(
  config: Config,
  calls: AgentCall[],
  input: {
    session: string
    role: Role
    attempt: number
    model: Model
    catalog: CatalogModel
    estimatedInputTokens: number
  },
) {
  const totals = usageTotals(calls, config.billing)
  if (config.billing === 'chatgpt-subscription' && input.model.providerID !== 'openai')
    throw new LoopStop(
      'setup-failure',
      'Subscription token accounting cannot authorize a paid provider',
    )
  if (calls.some((call) => call.billing !== config.billing))
    throw new Error('Mixed billing modes in one run are not permitted')
  if (!totals.complete)
    throw new LoopStop(
      'budget-exhausted',
      'Prior call usage is unknown; diagnose before making another model request',
    )
  const policy = config.budget
  const output = Math.min(policy.targetOutputTokensPerCall, input.catalog.limit.output)
  const rates =
    config.billing === 'chatgpt-subscription'
      ? null
      : {
          input: Math.max(
            ...input.catalog.cost.flatMap((tier) => [
              tier.input,
              tier.cache.read,
              tier.cache.write,
            ]),
          ),
          output: Math.max(...input.catalog.cost.map((tier) => tier.output)),
        }
  const reservedTokens = input.estimatedInputTokens + output
  const reservedUsd = rates
    ? (input.estimatedInputTokens * rates.input + output * rates.output) / 1_000_000
    : null
  if (
    input.estimatedInputTokens > policy.maxInputTokensPerCall ||
    input.estimatedInputTokens > (input.catalog.limit.input ?? input.catalog.limit.context) ||
    reservedTokens > input.catalog.limit.context ||
    totals.tokens + reservedTokens > policy.maxTotalTokens ||
    (totals.estimatedUsd !== null &&
      reservedUsd !== null &&
      totals.estimatedUsd + reservedUsd > policy.maxEstimatedUsd)
  )
    throw new LoopStop(
      'budget-exhausted',
      `Cannot admit ${input.role}: estimated ${reservedTokens} tokens${reservedUsd === null ? ' (subscription dollars unpriced)' : ` / $${reservedUsd.toFixed(4)}`} exceeds the remaining run/input budget; narrow the approved context or explicitly raise the budget`,
    )
  const call: AgentCall = {
    billing: config.billing,
    session: input.session,
    role: input.role,
    attempt: input.attempt,
    model: input.model,
    startedAt: new Date().toISOString(),
    estimatedInputTokens: input.estimatedInputTokens,
    outputTargetTokens: output,
    reservedTokens,
    reservedUsd,
    rates,
    modelOutputLimit: input.catalog.limit.output,
    status: 'reserved',
  }
  calls.push(call)
  return call
}
export function settleCall(call: AgentCall, before: Measurement, after: Measurement) {
  const parsed = measurementSchema.parse(after)
  const delta = measurementSchema.parse({
    cost: parsed.cost - before.cost,
    tokens: {
      input: parsed.tokens.input - before.tokens.input,
      output: parsed.tokens.output - before.tokens.output,
      reasoning: parsed.tokens.reasoning - before.tokens.reasoning,
      cache: {
        read: parsed.tokens.cache.read - before.tokens.cache.read,
        write: parsed.tokens.cache.write - before.tokens.cache.write,
      },
    },
  })
  call.observed = delta
  call.accountedTokens = countTokens(delta.tokens)
  const estimated = call.rates
    ? ((delta.tokens.input + delta.tokens.cache.read + delta.tokens.cache.write) *
        call.rates.input +
        (delta.tokens.output + delta.tokens.reasoning) * call.rates.output) /
      1_000_000
    : null
  call.accountedUsd = estimated === null ? null : Math.max(delta.cost, estimated)
  call.status = 'completed'
  call.finishedAt = new Date().toISOString()
  return parsed
}
export function assertBudget(config: Config, calls: AgentCall[]) {
  const totals = usageTotals(calls, config.billing)
  const oversizedInput = calls.some(
    (call) =>
      call.observed &&
      call.observed.tokens.input +
        call.observed.tokens.cache.read +
        call.observed.tokens.cache.write >
        config.budget.maxInputTokensPerCall,
  )
  if (
    !totals.complete ||
    oversizedInput ||
    totals.tokens > config.budget.maxTotalTokens ||
    (totals.estimatedUsd !== null && totals.estimatedUsd > config.budget.maxEstimatedUsd)
  )
    throw new LoopStop(
      'budget-exhausted',
      'Run token/cost budget exhausted or usage could not be reconciled; no further model calls authorized',
    )
}
export function usageReport(
  config: Config,
  calls: AgentCall[],
  sessions: UsageReport['sessions'],
): UsageReport {
  return {
    billing: config.billing,
    policy: config.budget,
    calls: structuredClone(calls),
    sessions,
    totals: usageTotals(calls, config.billing),
  }
}
