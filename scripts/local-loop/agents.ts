import { randomBytes } from 'node:crypto'
import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { Service } from '@opencode/client/service'
import { z } from 'zod'
import { LoopStop } from './coordinator.ts'
import {
  activeRoles,
  measurementSchema,
  modelForRole,
  type AgentCall,
  type Config,
  type Measurement,
  type Model,
  type Role,
} from './contracts.ts'
import {
  assertBudget,
  catalogSchema,
  countTokens,
  estimateInput,
  reserveCall,
  selectCatalogModel,
  settleCall,
  usageReport,
  zeroMeasurement,
  type CatalogModel,
} from './budget.ts'
import { assertChatGptSubscription } from './subscription.ts'

const permissions = [{ action: '*', resource: '*', effect: 'deny' as const }]
const sessionSchema = z.object({
  id: z.string().startsWith('ses_'),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional(),
  model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }),
})
type Client = Pick<
  OpenCodeClient,
  'server' | 'session' | 'permission' | 'message' | 'model' | 'integration' | 'provider'
>

export class AgentRunError extends LoopStop {
  details: unknown
  constructor(outcome: 'agent-error' | 'limit-exhausted', message: string, details: unknown) {
    super(outcome, message)
    this.details = details
  }
}

export class Agents {
  private client?: Client
  private owned = new Map<
    string,
    { role: Role; model: Model; catalog: CatalogModel; measurement: Measurement; history: number }
  >()
  private calls: AgentCall[] = []
  private catalog?: CatalogModel[]
  private prompts = new Map<string, string>()
  private config: Config
  private record: (ids: string[]) => Promise<void>
  constructor(config: Config, record: (ids: string[]) => Promise<void>, client?: Client) {
    this.config = config
    this.record = record
    this.client = client
  }

  async connect(signal: AbortSignal) {
    if (!this.client) {
      const endpoint = await Service.discover()
      if (!endpoint)
        throw new Error('Start an authenticated OpenCode V2 service before running the loop')
      this.client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    }
    const info = await this.client.server.info({ signal })
    // The installed client is pinned; runtime compatibility must be explicit.
    if (!info.version.startsWith('2.0.'))
      throw new Error('An OpenCode V2 2.0.x service is required')
  }

  async create(role: Role, signal: AbortSignal) {
    if (!this.client) throw new Error('OpenCode client not connected')
    await this.checkSubscription(signal)
    const model = modelForRole(this.config, role)
    if (!this.catalog) {
      this.catalog = catalogSchema.parse(
        await this.client.model.list(
          { location: { directory: this.config.workspace } },
          { signal },
        ),
      ).data
    }
    // Validate the entire active plan before the first paid prompt, not halfway through review.
    for (const activeRole of activeRoles(this.config))
      selectCatalogModel(this.catalog, modelForRole(this.config, activeRole), this.config.billing)
    const catalog = selectCatalogModel(this.catalog, model, this.config.billing)
    const id = `ses_${randomBytes(16).toString('hex')}`
    // Record ownership before the create request so an ambiguous transport failure is diagnosable.
    this.owned.set(id, { role, model, catalog, measurement: zeroMeasurement(), history: 0 })
    await this.record([...this.owned.keys()])
    const created = await this.client.session.create(
      {
        id,
        title: `Local loop: ${role}`,
        location: { directory: this.config.workspace },
        agent: 'build',
        model: {
          providerID: model.providerID,
          id: model.modelID,
          ...(model.variant ? { variant: model.variant } : {}),
        },
        permissions,
      },
      { signal },
    )
    const parsed = sessionSchema.safeParse(created)
    if (!parsed.success)
      throw new LoopStop('agent-error', 'OpenCode returned an invalid session handoff')
    const session = parsed.data
    if (session.id !== id)
      throw new LoopStop('agent-error', 'OpenCode returned a different session identity')
    this.assertModel(session.model, model)
    this.owned.get(id)!.measurement = measurementSchema.parse(created)
    // Exercise the actual permission evaluator, including agent rules and saved approvals,
    // without executing a model or a tool. Any non-deny prevents the first prompt.
    for (const action of [
      'read',
      'edit',
      'shell',
      'execute',
      'subagent',
      'webfetch',
      'opencode_session_move',
      'unknown_plugin_action',
    ]) {
      const result = z.object({ effect: z.literal('deny') }).safeParse(
        await this.client.permission.create(
          {
            sessionID: id,
            agent: 'build',
            action,
            resources: ['*'],
          },
          { signal },
        ),
      )
      if (!result.success)
        throw new LoopStop('setup-failure', `Session tool restriction is not enforced: ${action}`)
    }
    return id
  }

  private assertModel(
    actual: { providerID: string; id: string; variant?: string },
    expected: Model,
  ) {
    if (
      actual.providerID !== expected.providerID ||
      actual.id !== expected.modelID ||
      (expected.variant !== undefined && actual.variant !== expected.variant)
    )
      throw new LoopStop(
        'agent-error',
        'OpenCode selected a different model/variant; implicit fallback is not authorized',
      )
  }

  private async checkSubscription(signal: AbortSignal) {
    if (this.config.billing !== 'chatgpt-subscription') return
    if (!this.client) throw new Error('OpenCode client not connected')
    const location = { directory: this.config.workspace }
    const [integrations, provider, catalog] = await Promise.all([
      this.client.integration.list({ location }, { signal }),
      this.client.provider.get({ providerID: 'openai', location }, { signal }),
      this.client.model.list({ location }, { signal }),
    ])
    assertChatGptSubscription(this.config, integrations, provider, catalog)
  }

  usage() {
    return usageReport(
      this.config,
      this.calls,
      [...this.owned].map(([id, session]) => ({ id, role: session.role, model: session.model })),
    )
  }

  async run(sessionID: string, text: string, signal: AbortSignal, attempt = 0) {
    if (!this.client || !this.owned.has(sessionID)) throw new Error('Unowned agent session')
    signal.throwIfAborted()
    await this.checkSubscription(signal)
    const owned = this.owned.get(sessionID)!
    const prompt = text
    const call = reserveCall(this.config, this.calls, {
      session: sessionID,
      role: owned.role,
      attempt,
      model: owned.model,
      catalog: owned.catalog,
      estimatedInputTokens: estimateInput(
        prompt,
        owned.history,
        this.config.budget.overheadTokensPerCall,
      ),
    })
    await this.record([...this.owned.keys()])
    const timeout = AbortSignal.timeout(this.config.agentTimeoutMs)
    const bounded = AbortSignal.any([signal, timeout])
    const id = `msg_${randomBytes(16).toString('hex')}`
    this.prompts.set(sessionID, id)
    let messages: unknown
    try {
      const admitted = z
        .object({ id: z.literal(id) })
        .parse(
          await this.client.session.prompt({ sessionID, id, text: prompt }, { signal: bounded }),
        )
      await this.client.session.wait({ sessionID }, { signal: bounded })
      const rawSession = await this.client.session.get({ sessionID }, { signal: bounded })
      const session = sessionSchema.parse(rawSession)
      if (session.id !== sessionID)
        throw new LoopStop('agent-error', 'OpenCode returned counters for a different session')
      this.assertModel(session.model, owned.model)
      owned.measurement = settleCall(call, owned.measurement, measurementSchema.parse(rawSession))
      if (session.outcome === 'succeeded' && countTokens(call.observed!.tokens) === 0) {
        call.status = 'unknown'
        throw new LoopStop(
          'agent-error',
          'Successful generation has no reported token usage; refusing to treat it as free',
        )
      }
      owned.history +=
        Math.ceil(Buffer.byteLength(prompt) / 3) +
        (call.observed?.tokens.output ?? 0) +
        (call.observed?.tokens.reasoning ?? 0)
      await this.record([...this.owned.keys()])
      assertBudget(this.config, this.calls)
      const page = await this.client.message.list(
        { sessionID, order: 'desc', limit: 100 },
        { signal: bounded },
      )
      messages = page.data
      if (session.outcome !== 'succeeded')
        throw new LoopStop(
          'agent-error',
          `Session ${sessionID} ended ${session.outcome ?? 'without an outcome'}`,
        )
      const boundary = page.data.findIndex((message) => message.id === admitted.id)
      if (boundary < 0)
        throw new LoopStop(
          'agent-error',
          'Current prompt boundary is missing from session messages',
        )
      const current = page.data.slice(0, boundary)
      const assistant = current.find((message) => message.type === 'assistant')
      if (
        !assistant ||
        assistant.type !== 'assistant' ||
        assistant.error ||
        assistant.finish !== 'stop'
      )
        throw new LoopStop('agent-error', 'Missing, failed, or incomplete assistant response')
      if (
        current.some(
          (message) =>
            message.type === 'assistant' &&
            message.content.some((part) => part.type === 'tool' && part.executed),
        )
      )
        throw new LoopStop('agent-error', 'A tool executed in a tool-denied session')
      const output = assistant.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      return { output: JSON.parse(output) as unknown, messages: current }
    } catch (error) {
      if (call.status === 'reserved') {
        // Aborting HTTP is not cancellation of the agent. Stop the owned activity before
        // reconciling cumulative counters, including failed/partial/provider-retry work.
        try {
          const cleanupSignal = AbortSignal.timeout(10_000)
          await this.client.session.interrupt(
            { sessionID, resume: false },
            { signal: cleanupSignal },
          )
          await this.client.session.wait({ sessionID }, { signal: cleanupSignal })
          const after = await this.client.session.get({ sessionID }, { signal: cleanupSignal })
          const parsed = sessionSchema.parse(after)
          if (parsed.id !== sessionID) throw new Error('Usage belongs to a different session')
          this.assertModel(parsed.model, owned.model)
          owned.measurement = settleCall(call, owned.measurement, measurementSchema.parse(after))
        } catch {
          call.status = 'unknown'
          call.finishedAt = new Date().toISOString()
        }
      }
      await this.record([...this.owned.keys()])
      if (error instanceof LoopStop && error.outcome === 'budget-exhausted') throw error
      if (timeout.aborted && !signal.aborted)
        throw new AgentRunError('limit-exhausted', `Agent ${sessionID} exceeded its time limit`, {
          sessionID,
          messages,
        })
      if (signal.aborted) throw error
      throw new AgentRunError('agent-error', String(error), { sessionID, messages })
    }
  }

  async cleanup() {
    const errors: string[] = []
    if (!this.client) return errors
    for (const sessionID of this.owned.keys()) {
      const signal = AbortSignal.timeout(10_000)
      try {
        const permissions = await this.client.permission.list({ sessionID }, { signal })
        for (const request of permissions)
          await this.client.permission.reply(
            { sessionID, requestID: request.id, decision: 'reject' },
            { signal },
          )
        const items = await this.client.session.inbox.list({ sessionID }, { signal })
        for (const item of items) {
          if (item.id === this.prompts.get(sessionID))
            await this.client.session.inbox.cancel({ sessionID, inboxID: item.id }, { signal })
        }
        await this.client.session.interrupt({ sessionID, resume: false }, { signal })
        await this.client.session.wait({ sessionID }, { signal })
        const active = await this.client.session.active({ signal })
        if (active[sessionID]) throw new Error('Session is still active after interruption')
      } catch (error) {
        errors.push(`${sessionID}: ${String(error)}`)
      }
    }
    return errors
  }
}
