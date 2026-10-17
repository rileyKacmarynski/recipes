import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OpenCodeClient } from '@opencode/client'
import { Agents } from './local-loop/agents.ts'
import {
  assertBudget,
  catalogSchema,
  estimateInput,
  reserveCall,
  settleCall,
  usageTotals,
  zeroMeasurement,
} from './local-loop/budget.ts'
import { configSchema, modelForRole, type AgentCall, type Config } from './local-loop/contracts.ts'
import { LoopStop } from './local-loop/coordinator.ts'
import { assertChatGptSubscription } from './local-loop/subscription.ts'

const configuration = (overrides: Partial<Config> = {}) =>
  configSchema.parse({
    mode: 'verify',
    billing: 'metered',
    issue: '#29 cost fixture',
    workspace: '/workspace',
    contract: '/contract.md',
    evidence: '/evidence',
    model: 'fixture/balanced',
    scenarios: ['recipe'],
    ...overrides,
  })
const catalogEntry = (id = 'balanced', providerID = 'fixture') => ({
  id,
  providerID,
  enabled: true,
  package: '@opencode/ai/providers/openai',
  settings: { baseURL: 'https://chatgpt.com/backend-api/codex' },
  variants: [{ id: 'low' }],
  limit: { context: 200_000, output: 8_000 },
  cost: [{ input: 2, output: 8, cache: { read: 0.5, write: 3 } }],
})

test('explicit per-role model selectors support provider/model/variant and a declared default', () => {
  const c = configuration({
    models: {
      implementation: { providerID: 'coder', modelID: 'coding' },
      'security-review': { providerID: 'other', modelID: 'vendor/reasoner', variant: 'low' },
    },
  })
  assert.deepEqual(modelForRole(c, 'implementation'), { providerID: 'coder', modelID: 'coding' })
  assert.deepEqual(modelForRole(c, 'security-review'), {
    providerID: 'other',
    modelID: 'vendor/reasoner',
    variant: 'low',
  })
  assert.deepEqual(modelForRole(c, 'code-review'), { providerID: 'fixture', modelID: 'balanced' })
  const parsed = configSchema.parse({
    ...c,
    model: undefined,
    models: {
      'code-review': 'cheap/coding',
      'security-review': 'other/vendor/reasoner#low',
      verification: 'cheap/small',
    },
  })
  assert.equal(modelForRole(parsed, 'security-review').modelID, 'vendor/reasoner')
  assert.throws(() => configSchema.parse({ ...c, model: undefined, models: {} }), /explicit model/)
  assert.throws(() => configSchema.parse({ ...c, models: { typo: 'provider/model' } }))
  assert.throws(() => configSchema.parse({ ...c, budget: { maxEstimatedUsd: 0 } }))
})

test('reservations use undiscounted maximum tier rates, reconcile cumulative counters once, and cover reasoning/cache', () => {
  const c = configuration()
  const calls: AgentCall[] = []
  const catalog = catalogSchema.parse({ data: [catalogEntry()] }).data[0]!
  const call = reserveCall(c, calls, {
    session: 'ses_1',
    role: 'code-review',
    attempt: 1,
    model: modelForRole(c, 'code-review'),
    catalog,
    estimatedInputTokens: 1_000,
  })
  assert.equal(call.reservedTokens, 3_000)
  assert.equal(call.reservedUsd, 0.019)
  const first = {
    cost: 0.004,
    tokens: { input: 500, output: 100, reasoning: 20, cache: { read: 200, write: 10 } },
  }
  settleCall(call, zeroMeasurement(), first)
  assert.equal(call.accountedTokens, 830)
  assert.equal(call.accountedUsd, 0.004)
  const second = reserveCall(c, calls, {
    session: 'ses_1',
    role: 'code-review',
    attempt: 2,
    model: modelForRole(c, 'code-review'),
    catalog,
    estimatedInputTokens: 2_000,
  })
  settleCall(second, first, {
    cost: 0.01,
    tokens: { input: 1_000, output: 200, reasoning: 40, cache: { read: 400, write: 20 } },
  })
  assert.equal(second.observed?.cost, 0.006)
  assert.equal(usageTotals(calls).reportedUsd, 0.01)
  assert.equal(usageTotals(calls).tokens, 1_660)
  assert.ok(estimateInput('new request', 500, 4_096) > 4_596)
})

test('token, estimated-dollar and per-call input admission limits stop before any new reservation', () => {
  const catalog = catalogEntry()
  for (const policy of [
    { maxTotalTokens: 100 },
    { maxEstimatedUsd: 0.00001 },
    { maxInputTokensPerCall: 50 },
  ]) {
    const c = configuration({ budget: { ...configuration().budget, ...policy } })
    const calls: AgentCall[] = []
    assert.throws(
      () =>
        reserveCall(c, calls, {
          session: 'ses_1',
          role: 'security-review',
          attempt: 1,
          model: modelForRole(c, 'security-review'),
          catalog,
          estimatedInputTokens: 1_000,
        }),
      (error) => error instanceof LoopStop && error.outcome === 'budget-exhausted',
    )
    assert.deepEqual(calls, [])
  }
})

test('actual overrun and unknown usage block subsequent calls instead of pretending reservations are hard caps', () => {
  const c = configuration({ budget: { ...configuration().budget, maxTotalTokens: 4_000 } })
  const calls: AgentCall[] = []
  const call = reserveCall(c, calls, {
    session: 'ses_1',
    role: 'verification',
    attempt: 1,
    model: modelForRole(c, 'verification'),
    catalog: catalogEntry(),
    estimatedInputTokens: 1_000,
  })
  settleCall(call, zeroMeasurement(), {
    cost: 0,
    tokens: { input: 2_000, output: 4_000, reasoning: 500, cache: { read: 0, write: 0 } },
  })
  assert.throws(() => assertBudget(c, calls), /exhausted/)
  call.status = 'unknown'
  assert.equal(usageTotals(calls).complete, false)
  assert.throws(
    () =>
      reserveCall(configuration(), calls, {
        session: 'ses_2',
        role: 'verification',
        attempt: 1,
        model: modelForRole(c, 'verification'),
        catalog: catalogEntry(),
        estimatedInputTokens: 10,
      }),
    /usage is unknown/,
  )
})

function clientFixture(catalog = [catalogEntry()]) {
  const sessions = new Map<string, { providerID: string; id: string; variant?: string }>()
  const promptIDs = new Map<string, string>()
  let prompts = 0
  const client = {
    integration: {
      list: async () => ({
        data: [{ id: 'openai', connections: [{ type: 'credential', method: 'oauth' }] }],
      }),
    },
    provider: {
      get: async () => ({
        data: {
          package: '@opencode/ai/providers/openai',
          settings: { baseURL: 'https://chatgpt.com/backend-api/codex' },
        },
      }),
    },
    model: { list: async () => ({ data: catalog }) },
    session: {
      create: async (input: {
        id: string
        model: { providerID: string; id: string; variant?: string }
        permissions: unknown
      }) => {
        assert.deepEqual(input.permissions, [{ action: '*', resource: '*', effect: 'deny' }])
        sessions.set(input.id, input.model)
        return { id: input.id, model: input.model, ...zeroMeasurement() }
      },
      prompt: async (input: { sessionID: string; id: string }) => {
        prompts++
        promptIDs.set(input.sessionID, input.id)
        return { id: input.id }
      },
      wait: async () => {},
      get: async (input: { sessionID: string }) => ({
        id: input.sessionID,
        model: sessions.get(input.sessionID),
        outcome: 'succeeded',
        cost: 0.001,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      interrupt: async () => {},
      inbox: { list: async () => [] },
      active: async () => ({}),
    },
    permission: { create: async () => ({ effect: 'deny' }), list: async () => [] },
    message: {
      list: async (input: { sessionID: string }) => ({
        data: [
          {
            id: 'msg_answer',
            type: 'assistant',
            finish: 'stop',
            content: [{ type: 'text', text: '{"decision":"approve"}' }],
          },
          { id: promptIDs.get(input.sessionID), type: 'user' },
        ],
      }),
    },
  } as unknown as OpenCodeClient
  return {
    client,
    sessions,
    get prompts() {
      return prompts
    },
  }
}

test('coder and each adversary use their selected models and retain role/session/attempt usage', async () => {
  const roles = [
    'implementation',
    'code-review',
    'security-review',
    'architecture-review',
    'verification',
  ] as const
  const c = configuration({
    mode: 'implement',
    writableFiles: ['packages/core/src/index.ts'],
    architectureReview: true,
    models: Object.fromEntries(
      roles.map((role) => [role, { providerID: 'fixture', modelID: role }]),
    ),
  })
  const f = clientFixture(roles.map((role) => catalogEntry(role)))
  const agents = new Agents(c, async () => {}, f.client)
  for (const role of roles) {
    const id = await agents.create(role, new AbortController().signal)
    assert.equal(f.sessions.get(id)?.id, role)
    await agents.run(id, 'small handoff', new AbortController().signal, 1)
  }
  assert.equal(f.prompts, 5)
  assert.deepEqual(
    agents.usage().calls.map((call) => call.role),
    [...roles],
  )
  assert.equal(agents.usage().totals.tokens, 550)
  assert.equal(agents.usage().totals.reportedUsd, 0.005)
  assert.ok(agents.usage().calls.every((call) => call.attempt === 1 && call.status === 'completed'))
  assert.deepEqual(await agents.cleanup(), [])
})

test('unavailable models, implicit model changes, missing prices and unaffordable handoffs never trigger a paid prompt', async () => {
  const signal = new AbortController().signal
  for (const selected of ['fixture/missing', 'fixture/balanced#missing']) {
    const f = clientFixture()
    await assert.rejects(
      new Agents(
        configuration({
          model: {
            providerID: 'fixture',
            modelID: selected.split('/')[1]!.split('#')[0]!,
            ...(selected.includes('#') ? { variant: 'missing' } : {}),
          },
        }),
        async () => {},
        f.client,
      ).create('verification', signal),
      /unavailable/,
    )
    assert.equal(f.prompts, 0)
  }
  const missingPrice = clientFixture([{ ...catalogEntry(), cost: [] }])
  await assert.rejects(
    new Agents(configuration(), async () => {}, missingPrice.client).create('verification', signal),
    /Pricing metadata/,
  )
  const f = clientFixture()
  const c = configuration({ budget: { ...configuration().budget, maxEstimatedUsd: 0.00001 } })
  const agents = new Agents(c, async () => {}, f.client)
  const id = await agents.create('verification', signal)
  await assert.rejects(agents.run(id, 'handoff', signal), /Cannot admit/)
  assert.equal(f.prompts, 0)
  const changed = clientFixture()
  changed.client.session.create = async (input) =>
    ({
      id: input!.id,
      model: { providerID: 'other', id: 'expensive' },
      ...zeroMeasurement(),
    }) as never
  await assert.rejects(
    new Agents(configuration(), async () => {}, changed.client).create('verification', signal),
    /implicit fallback/,
  )
})

test('catalog snapshots discard provider credentials rather than putting them into cost evidence', () => {
  const parsed = catalogSchema.parse({
    data: [
      { ...catalogEntry(), settings: { apiKey: 'SECRET' }, headers: { authorization: 'SECRET' } },
    ],
  })
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false)
})

test('an unavailable later reviewer is detected before spending on an earlier role', async () => {
  const f = clientFixture()
  const c = configuration({
    models: { 'security-review': { providerID: 'fixture', modelID: 'missing' } },
  })
  const agents = new Agents(c, async () => {}, f.client)
  await assert.rejects(agents.create('code-review', new AbortController().signal), /unavailable/)
  assert.equal(f.sessions.size, 0)
  assert.equal(f.prompts, 0)
})

test('missing usage counters are retained as unknown and cannot authorize another call', async () => {
  const f = clientFixture()
  f.client.session.get = async () => ({ id: 'ses_wrong', outcome: 'succeeded' }) as never
  const agents = new Agents(configuration(), async () => {}, f.client)
  const signal = new AbortController().signal
  const id = await agents.create('verification', signal)
  await assert.rejects(agents.run(id, 'first call', signal))
  assert.equal(agents.usage().calls[0]!.status, 'unknown')
  assert.equal(agents.usage().totals.complete, false)
  assert.ok(agents.usage().totals.tokens > 0)
  await assert.rejects(agents.run(id, 'second call', signal), /usage is unknown/)
  assert.equal(f.prompts, 1)
  await agents.cleanup()
})

test('a real counter overrun rejects the response before it can authorize implementation or verification', async () => {
  const f = clientFixture()
  const originalGet = f.client.session.get
  f.client.session.get = async (input, options) => ({
    ...(await originalGet(input, options)),
    tokens: { input: 1_000, output: 15_000, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const c = configuration({ budget: { ...configuration().budget, maxTotalTokens: 10_000 } })
  const agents = new Agents(c, async () => {}, f.client)
  const signal = new AbortController().signal
  const id = await agents.create('verification', signal)
  await assert.rejects(
    agents.run(id, 'small admitted request', signal),
    (error) => error instanceof LoopStop && error.outcome === 'budget-exhausted',
  )
  assert.equal(f.prompts, 1)
  assert.equal(agents.usage().totals.tokens, 16_000)
  assert.equal(agents.usage().calls[0]!.status, 'completed')
  await agents.cleanup()
})

test('ChatGPT subscription is the default and refuses any paid-provider selections', () => {
  const c = configuration({
    billing: 'chatgpt-subscription',
    model: { providerID: 'openai', modelID: 'balanced' },
  })
  assert.equal(configSchema.parse({ ...c, billing: undefined }).billing, 'chatgpt-subscription')
  assert.throws(
    () => configSchema.parse({ ...c, model: 'amazon-bedrock/some-model' }),
    /only permits openai/,
  )
  assert.throws(
    () => configSchema.parse({ ...c, models: { verification: 'other/paid-model' } }),
    /paid API provider fallback/,
  )
})

test('OAuth subscription calls accept unpriced models, enforce token limits, and report USD as unknown rather than free', async () => {
  const c = configuration({
    billing: 'chatgpt-subscription',
    model: { providerID: 'openai', modelID: 'balanced' },
    budget: { ...configuration().budget, maxEstimatedUsd: 0.00000001 },
  })
  const f = clientFixture([{ ...catalogEntry('balanced', 'openai'), cost: [] }])
  const agents = new Agents(c, async () => {}, f.client)
  const signal = new AbortController().signal
  const id = await agents.create('verification', signal)
  await agents.run(id, 'subscription handoff', signal, 1)
  const usage = agents.usage()
  assert.equal(usage.billing, 'chatgpt-subscription')
  assert.equal(usage.totals.tokens, 110)
  assert.equal(usage.totals.estimatedUsd, null)
  assert.equal(usage.totals.reportedUsd, null)
  assert.equal(usage.calls[0]!.reservedUsd, null)
  assert.equal(usage.calls[0]!.accountedUsd, null)
  assert.equal(usage.calls[0]!.rates, null)
  const calls: AgentCall[] = []
  assert.throws(
    () =>
      reserveCall({ ...c, budget: { ...c.budget, maxTotalTokens: 100 } }, calls, {
        session: id,
        role: 'verification',
        attempt: 2,
        model: modelForRole(c, 'verification'),
        catalog: catalogEntry('balanced', 'openai'),
        estimatedInputTokens: 1_000,
      }),
    /Cannot admit/,
  )
  await agents.cleanup()
})

test('subscription route verification rejects API keys, ambient keys, expired OAuth and paid/custom endpoints', () => {
  const c = configuration({
    billing: 'chatgpt-subscription',
    model: { providerID: 'openai', modelID: 'balanced' },
  })
  const integration = {
    data: [{ id: 'openai', connections: [{ type: 'credential', method: 'oauth' }] }],
  }
  const route = {
    package: '@opencode/ai/providers/openai',
    settings: { baseURL: 'https://chatgpt.com/backend-api/codex' },
  }
  const models = { data: [catalogEntry('balanced', 'openai')] }
  assert.doesNotThrow(() => assertChatGptSubscription(c, integration, { data: route }, models))
  for (const connections of [
    [],
    [{ type: 'credential', method: 'key' }],
    [{ type: 'env' }],
    [{ type: 'credential', method: 'oauth', status: { status: 'needs_auth' } }],
    [{ type: 'credential', method: 'oauth' }, { type: 'env' }],
  ])
    assert.throws(
      () =>
        assertChatGptSubscription(
          c,
          { data: [{ id: 'openai', connections }] },
          { data: route },
          models,
        ),
      /OAuth-only/,
    )
  for (const unsafe of [
    { ...route, settings: { baseURL: 'https://api.openai.com/v1' } },
    { ...route, settings: { baseURL: 'https://chatgpt.com.evil.example' } },
    { ...route, settings: { ...route.settings, apiKey: 'REDACTED' } },
    { ...route, headers: { Authorization: 'REDACTED' } },
    { ...route, package: '@custom/provider' },
  ]) {
    assert.throws(
      () => assertChatGptSubscription(c, integration, { data: unsafe }, models),
      /refuses/,
    )
    assert.throws(
      () =>
        assertChatGptSubscription(
          c,
          integration,
          { data: route },
          { data: [{ ...catalogEntry('balanced', 'openai'), ...unsafe }] },
        ),
      /refuses/,
    )
  }
})

test('an account/endpoint switch is caught again immediately before prompting', async () => {
  const f = clientFixture([{ ...catalogEntry('balanced', 'openai'), cost: [] }])
  const agents = new Agents(
    configuration({
      billing: 'chatgpt-subscription',
      model: { providerID: 'openai', modelID: 'balanced' },
    }),
    async () => {},
    f.client,
  )
  const signal = new AbortController().signal
  const id = await agents.create('verification', signal)
  f.client.provider.get = async () =>
    ({
      data: {
        package: '@opencode/ai/providers/openai',
        settings: { baseURL: 'https://api.openai.com/v1' },
      },
    }) as never
  await assert.rejects(agents.run(id, 'blocked before inference', signal), /no paid fallback/)
  assert.equal(f.prompts, 0)
  assert.equal(agents.usage().calls.length, 0)
  await agents.cleanup()
})
