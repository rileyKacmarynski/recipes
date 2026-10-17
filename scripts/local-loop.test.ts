import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { OpenCodeClient } from '@opencode/client'
import { Agents, AgentRunError } from './local-loop/agents.ts'
import { configSchema, type Attempt, type Config, type Role } from './local-loop/contracts.ts'
import { LoopStop, runLoop, type Runtime } from './local-loop/coordinator.ts'
import { applyEdits, localRuntime } from './local-loop/runtime.ts'
import { cleanEnvironment, sandboxCommand, validateSandbox } from './local-loop/sandbox.mjs'
import {
  createReviewHandoff,
  loadReviewGuidance,
  reviewGuidanceFiles,
} from './local-loop/review-guidance.ts'

const config = (overrides: Partial<Config> = {}) =>
  configSchema.parse({
    issue: '#29 fixture',
    billing: 'metered',
    workspace: '/workspace',
    contract: '/approved.md',
    evidence: '/evidence/run',
    model: { providerID: 'fixture', modelID: 'controlled' },
    writableFiles: ['packages/core/src/index.ts'],
    scenarios: ['empty', 'create'],
    ...overrides,
  })
const approve = {
  decision: 'approve',
  findings: [],
  coveredScenarios: ['empty', 'create'],
  repairRationale: '',
}
const reviewApprove = { decision: 'approve', findings: [], repairRationale: '' }
const rejected = {
  decision: 'product-failure',
  findings: ['Create expectation fails'],
  coveredScenarios: ['empty', 'create'],
  repairRationale: 'Fix recipe creation without changing its expectations',
}
const timestamp = '2026-10-17T12:00:00.000Z'
const catalogFixture = () => ({
  data: [
    {
      id: 'controlled',
      providerID: 'fixture',
      enabled: true,
      variants: [],
      limit: { context: 100_000, output: 8_000 },
      cost: [{ input: 2, output: 8, cache: { read: 1, write: 2 } }],
    },
  ],
})
const sessionFixture = (id: string, outcome = 'succeeded', input = 100, output = 10) => ({
  id,
  outcome,
  model: { providerID: 'fixture', id: 'controlled' },
  cost: 0,
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
})

test('review handoffs supply role-specific skills, shared code judgment and the validated output contract', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const guidance = await loadReviewGuidance(root)
  for (const role of ['code-review', 'security-review', 'architecture-review'] as const) {
    const handoff = createReviewHandoff(role, guidance.byRole)
    assert.deepEqual(Object.keys(handoff.reviewGuidance), [...reviewGuidanceFiles[role]])
    for (const [path, content] of Object.entries(handoff.reviewGuidance))
      assert.equal(content, await readFile(resolve(root, path), 'utf8'))
    assert.equal(handoff.outputSchema.additionalProperties, false)
    assert.deepEqual(handoff.outputSchema.required, ['decision', 'findings', 'repairRationale'])
    assert.equal('permissions' in handoff, false)
    assert.equal('commands' in handoff, false)
  }
  assert.equal('.agents/skills/code-review/SKILL.md' in guidance.byRole['code-review'], false)
  assert.ok('.agents/skills/code-review/REVIEW-GUIDANCE.md' in guidance.byRole['code-review'])
  assert.ok(
    '.agents/skills/architecture-preferences/SKILL.md' in guidance.byRole['architecture-review'],
  )
  const interactive = await readFile(resolve(root, '.agents/skills/code-review/SKILL.md'), 'utf8')
  assert.match(interactive, /\]\(REVIEW-GUIDANCE\.md\)/)
  assert.throws(() => createReviewHandoff('security-review', undefined), /Missing review guidance/)
})

test('the review packet retains full current and superseded ADRs with their source paths', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const guidance = await loadReviewGuidance(root)
  for (const path of [
    'doc/adr/0005-review-authoritative-actions-plans-before-production-mutation.md',
    'doc/adr/0006-apply-actions-plans-automatically-after-source-review.md',
    'doc/adr/0007-separate-local-artifact-production-from-black-box-acceptance.md',
    'doc/adr/0008-bound-local-agent-work-with-tool-denial-and-process-isolation.md',
  ]) {
    assert.equal(guidance.adrs[path], await readFile(resolve(root, path), 'utf8'))
    assert.equal(guidance.files[path], guidance.adrs[path])
  }
  assert.equal('doc/adr/README.md' in guidance.adrs, false)
})

test('missing or empty review skill files stop loading instead of falling back to an inline prompt', async () => {
  const original = await loadReviewGuidance(fileURLToPath(new URL('../', import.meta.url)))
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'loop-guidance-')))
  const omitted = '.agents/skills/security-review/SKILL.md'
  for (const [path, content] of Object.entries(original.files)) {
    await mkdir(resolve(root, path, '..'), { recursive: true })
    if (path !== omitted) await writeFile(resolve(root, path), content)
  }
  await assert.rejects(loadReviewGuidance(root), /ENOENT/)
  await writeFile(resolve(root, omitted), ' \n')
  await assert.rejects(loadReviewGuidance(root), /Review guidance is empty/)
})

function fixture(
  options: {
    agent?: (role: Role, attempt: number) => unknown
    productFailure?: (number: number) => boolean
    uat?: (attempt: Attempt) => unknown
    commandFailure?: string
    protectedMutation?: boolean
    sessionReuse?: boolean
    interrupt?: AbortController
    timeout?: boolean
  } = {},
) {
  let number = 0
  let edits = 0
  let cleaned = false
  const commands: string[] = []
  const sessions: { role: Role; id: string }[] = []
  const saved: unknown[] = []
  const runtime: Runtime = {
    async initialize() {
      return {
        reference: '/approved.md',
        snapshot: '/evidence/run/contract.md',
        sha256: 'c'.repeat(64),
      }
    },
    async assertProtected() {
      if (options.protectedMutation && edits)
        throw new LoopStop('protected-input-mutation', 'tool changed')
    },
    async createSession(role) {
      const id = options.sessionReuse ? 'ses_reused' : `ses_${sessions.length + 1}`
      sessions.push({ role, id })
      return id
    },
    async agent(_session, role, _input, signal) {
      if (options.interrupt) {
        options.interrupt.abort()
        signal.throwIfAborted()
      }
      if (options.timeout) throw new LoopStop('limit-exhausted', 'Agent timed out')
      if (options.agent) return options.agent(role, number)
      return role === 'implementation'
        ? { status: 'ready', rationale: 'Authorized source change', files: [] }
        : role === 'verification'
          ? options.productFailure?.(number)
            ? rejected
            : approve
          : reviewApprove
    },
    async apply() {
      edits++
    },
    async command(name, attempt) {
      commands.push(`${attempt.number}:${name}`)
      return {
        name,
        code:
          options.commandFailure === name ||
          (name === 'uat' && options.productFailure?.(attempt.number))
            ? 1
            : 0,
        signal: null,
        startedAt: timestamp,
        finishedAt: timestamp,
        log: `${attempt.evidence}/${name}.log`,
      }
    },
    async candidate(attempt) {
      return { path: `${attempt.evidence}/artifacts`, sha256: String(attempt.number).repeat(64) }
    },
    async uat(attempt) {
      if (options.uat) return options.uat(attempt)
      return {
        outcome: options.productFailure?.(attempt.number) ? 'expectation-failed' : 'passed',
        startedAt: timestamp,
        finishedAt: timestamp,
        artifacts: attempt.candidate,
        scenarios: ['empty', 'create'].map((name) => ({
          name,
          passed: !(name === 'create' && options.productFailure?.(attempt.number)),
          results: [
            {
              results: [
                {
                  status:
                    name === 'create' && options.productFailure?.(attempt.number)
                      ? 'failed'
                      : 'passed',
                },
              ],
            },
          ],
        })),
        cleanup: [{ resource: 'postgres', stopped: true }],
        evidence: `${attempt.evidence}/uat`,
      }
    },
    async save(report) {
      number = report.attempts.at(-1)?.number ?? 0
      saved.push(structuredClone(report))
    },
    async cleanup() {
      cleaned = true
      return []
    },
  }
  return {
    runtime,
    commands,
    sessions,
    saved,
    get edits() {
      return edits
    },
    get cleaned() {
      return cleaned
    },
  }
}

test('complete success requires deterministic checks, adversarial reviews and a fresh acceptance verifier', async () => {
  const f = fixture()
  const report = await runLoop(config({ architectureReview: true }), f.runtime)
  assert.equal(report.outcome, 'proposed-pass')
  assert.deepEqual(f.commands, ['1:lint', '1:typecheck', '1:test:unit', '1:build:uat', '1:uat'])
  assert.deepEqual(
    f.sessions.map((session) => session.role),
    ['implementation', 'code-review', 'security-review', 'architecture-review', 'verification'],
  )
  assert.deepEqual(
    report.transitions.map((transition) => transition.state),
    ['checks', 'review', 'build', 'uat', 'verification', 'stopped'],
  )
  assert.equal(report.finalCandidate?.sha256, '1'.repeat(64))
  assert.match(report.approval, /Human approval required/)
  assert.equal(f.cleaned, true)
})

test('product failure repairs in the same implementation session, preserving candidates and fresh reviews', async () => {
  const f = fixture({ productFailure: (number) => number === 1 })
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'proposed-pass')
  assert.equal(report.attempts.length, 2)
  assert.equal(f.sessions.filter((session) => session.role === 'implementation').length, 1)
  assert.notEqual(report.attempts[0]!.verifierSession, report.attempts[1]!.verifierSession)
  assert.equal(report.attempts[0]!.candidate?.sha256, '1'.repeat(64))
  assert.equal(report.finalCandidate?.sha256, '2'.repeat(64))
  assert.match(report.attempts[0]!.repairRationale!, /recipe creation/)
})

test('adversarial rejection prevents building/UAT, then fresh reviews gate the repair', async () => {
  const f = fixture({
    agent: (role, number) =>
      role === 'implementation'
        ? { status: 'ready', rationale: 'Repair', files: [] }
        : role === 'security-review' && number === 1
          ? {
              decision: 'product-failure',
              findings: ['Missing authorization'],
              repairRationale: 'Enforce existing authorization contract',
            }
          : role === 'verification'
            ? approve
            : reviewApprove,
  })
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'proposed-pass')
  assert.equal(f.commands.includes('1:build:uat'), false)
  assert.equal(f.commands.includes('1:uat'), false)
  assert.equal(report.attempts[0]!.candidate, undefined)
  assert.equal(report.attempts[1]!.reviews.length, 2)
})

test('setup failure stops without a product rewrite or verifier', async () => {
  const f = fixture({ uat: () => ({ outcome: 'setup-error', error: 'Docker unavailable' }) })
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'setup-failure')
  assert.equal(f.edits, 1)
  assert.equal(report.attempts.length, 1)
  assert.equal(report.attempts[0]!.verifierSession, undefined)
})

test('ambiguous check failure cannot be narrated into success or authorize repairs', async () => {
  const f = fixture({ commandFailure: 'test:unit' })
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'needs-human')
  assert.equal(f.commands.includes('1:build:uat'), false)
  assert.equal(report.attempts.length, 1)
})

test('verify-only mode runs independent reviews and UAT without an implementer or edits', async () => {
  const f = fixture()
  const report = await runLoop(config({ mode: 'verify', writableFiles: [] }), f.runtime)
  assert.equal(report.outcome, 'proposed-pass')
  assert.equal(report.mode, 'verify')
  assert.equal(f.edits, 0)
  assert.equal(
    f.sessions.some((session) => session.role === 'implementation'),
    false,
  )
  assert.equal(report.attempts[0]!.implementationSession, undefined)
  assert.equal(f.commands.at(-1), '1:uat')
})

test('verify-only findings return to the human instead of triggering automatic repair', async () => {
  const f = fixture({ productFailure: () => true })
  const report = await runLoop(config({ mode: 'verify', writableFiles: [] }), f.runtime)
  assert.equal(report.outcome, 'product-failure')
  assert.equal(report.attempts.length, 1)
  assert.equal(f.edits, 0)
  assert.match(report.reason!, /repair together/)
})

for (const role of ['implementation', 'code-review', 'security-review', 'verification'] as Role[]) {
  test(`missing/malformed ${role} output stops the protocol`, async () => {
    const f = fixture({
      agent: (current) =>
        current === role
          ? null
          : current === 'implementation'
            ? { status: 'ready', rationale: 'No changes', files: [] }
            : current === 'verification'
              ? approve
              : reviewApprove,
    })
    const report = await runLoop(config(), f.runtime)
    assert.equal(report.outcome, 'agent-error')
    assert.equal(f.cleaned, true)
  })
}

test('a green machine result is insufficient when the verifier finds incomplete contract coverage', async () => {
  const f = fixture({
    agent: (role) =>
      role === 'implementation'
        ? { status: 'ready', rationale: 'Ready', files: [] }
        : role === 'verification'
          ? { ...approve, coveredScenarios: ['empty'] }
          : reviewApprove,
  })
  assert.equal((await runLoop(config(), f.runtime)).outcome, 'verifier-uncertainty')
})

test('verifier approval cannot override failed deterministic acceptance', async () => {
  const f = fixture({
    productFailure: () => true,
    agent: (role) =>
      role === 'implementation'
        ? { status: 'ready', rationale: 'Ready', files: [] }
        : role === 'verification'
          ? approve
          : reviewApprove,
  })
  assert.equal((await runLoop(config(), f.runtime)).outcome, 'product-failure')
})

test('missing/skipped required scenario evidence never passes', async () => {
  const f = fixture({
    uat: (attempt) => ({
      outcome: 'passed',
      startedAt: timestamp,
      finishedAt: timestamp,
      artifacts: attempt.candidate,
      scenarios: [],
      cleanup: [{ resource: 'postgres', stopped: true }],
      evidence: `${attempt.evidence}/uat`,
    }),
  })
  assert.equal((await runLoop(config(), f.runtime)).outcome, 'setup-failure')
})

test('attempt exhaustion and identical repeated failures stop bounded repairs', async () => {
  for (const maxAttempts of [1, 3]) {
    const f = fixture({ productFailure: () => true })
    const report = await runLoop(config({ maxAttempts }), f.runtime)
    assert.equal(report.outcome, 'limit-exhausted')
    assert.equal(report.attempts.length, maxAttempts === 1 ? 1 : 2)
  }
})

test('protected-input mutation stops before executing checks', async () => {
  const f = fixture({ protectedMutation: true })
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'protected-input-mutation')
  assert.deepEqual(f.commands, [])
})

test('session reuse is rejected even with a green narrative', async () => {
  const f = fixture({ sessionReuse: true })
  assert.equal((await runLoop(config(), f.runtime)).outcome, 'agent-error')
})

test('agent timeout and user interruption stop owned activity and retain the attempt', async () => {
  for (const timeout of [false, true]) {
    const interrupt = timeout ? undefined : new AbortController()
    const f = fixture({ interrupt, timeout })
    const report = await runLoop(config(), f.runtime, interrupt?.signal)
    assert.equal(report.outcome, timeout ? 'limit-exhausted' : 'interrupted')
    assert.equal(report.attempts.length, 1)
    assert.equal(f.cleaned, true)
  }
})

test('budget exhaustion stops the loop without applying a repair or invoking checks', async () => {
  const f = fixture()
  f.runtime.agent = async () => {
    throw new LoopStop('budget-exhausted', 'No allowance for this call')
  }
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'budget-exhausted')
  assert.equal(f.edits, 0)
  assert.deepEqual(f.commands, [])
  assert.equal(f.cleaned, true)
})

test('OpenCode lifecycle correlates the current prompt, validates completion, and interrupts only owned sessions', async () => {
  let sessionID = ''
  let messageID = ''
  const interrupted: string[] = []
  const checks: string[] = []
  const client = {
    model: { list: async () => catalogFixture() },
    server: { info: async () => ({ version: '2.0.30' }) },
    session: {
      create: async (input: { id: string; permissions: unknown }) => {
        sessionID = input.id
        assert.deepEqual(input.permissions, [{ action: '*', resource: '*', effect: 'deny' }])
        return sessionFixture(sessionID, 'succeeded', 0, 0)
      },
      prompt: async (input: { id: string }) => {
        messageID = input.id
        return { id: messageID }
      },
      wait: async () => {},
      get: async () => sessionFixture(sessionID),
      inbox: { list: async () => [] },
      interrupt: async (input: { sessionID: string; resume: boolean }) => {
        assert.equal(input.resume, false)
        interrupted.push(input.sessionID)
      },
      active: async () => ({ ses_unrelated: { type: 'running' } }),
    },
    permission: {
      create: async (input: { action: string }) => {
        checks.push(input.action)
        return { effect: 'deny' }
      },
      list: async () => [],
    },
    message: {
      list: async () => ({
        data: [
          {
            id: 'msg_response',
            type: 'assistant',
            finish: 'stop',
            content: [{ type: 'text', text: '{"ok":true}' }],
          },
          { id: messageID, type: 'user' },
          {
            id: 'msg_old',
            type: 'assistant',
            finish: 'stop',
            content: [{ type: 'text', text: '{"old":true}' }],
          },
        ],
      }),
    },
  } as unknown as OpenCodeClient
  const agents = new Agents(config(), async () => {}, client)
  await agents.connect(new AbortController().signal)
  const id = await agents.create('security-review', new AbortController().signal)
  assert.ok(checks.includes('unknown_plugin_action'))
  assert.deepEqual(
    (await agents.run(id, 'controlled request', new AbortController().signal)).output,
    { ok: true },
  )
  assert.deepEqual(await agents.cleanup(), [])
  assert.deepEqual(interrupted, [id])
  client.session.get = async () => sessionFixture(id, 'failed') as never
  await assert.rejects(
    agents.run(id, 'failure request', new AbortController().signal),
    (error) => error instanceof AgentRunError && error.outcome === 'agent-error',
  )
  client.session.get = async () => sessionFixture(id, 'succeeded', 200, 20) as never
  client.message.list = async () => ({ data: [], cursor: {} })
  await assert.rejects(
    agents.run(id, 'missing reply', new AbortController().signal),
    /prompt boundary/,
  )
  await agents.cleanup()
})

test('the permission preflight blocks agent execution if restrictions resolve to allow or ask', async () => {
  for (const effect of ['allow', 'ask']) {
    let prompted = false
    const client = {
      model: { list: async () => catalogFixture() },
      session: {
        create: async (input: { id: string }) => sessionFixture(input.id, 'succeeded', 0, 0),
        prompt: async () => {
          prompted = true
        },
      },
      permission: { create: async () => ({ effect }) },
    } as unknown as OpenCodeClient
    const agents = new Agents(config(), async () => {}, client)
    await assert.rejects(
      agents.create('verification', new AbortController().signal),
      /not enforced/,
    )
    assert.equal(prompted, false)
  }
})

test('agent deadlines abort the request and cleanup cancels only the owned queued prompt', async () => {
  let id = ''
  let prompt = ''
  let stalled = true
  const canceled: string[] = []
  const client = {
    model: { list: async () => catalogFixture() },
    session: {
      create: async (input: { id: string }) => {
        id = input.id
        return sessionFixture(id, 'succeeded', 0, 0)
      },
      prompt: async (input: { id: string }) => {
        prompt = input.id
        return { id: prompt }
      },
      wait: async (_input: unknown, options: { signal: AbortSignal }) => {
        if (stalled)
          await new Promise((_, reject) => {
            if (options.signal.aborted) reject(options.signal.reason)
            else
              options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                once: true,
              })
          })
      },
      inbox: {
        list: async () => [{ id: prompt }, { id: 'msg_unrelated' }],
        cancel: async (input: { inboxID: string }) => {
          canceled.push(input.inboxID)
        },
      },
      interrupt: async () => {
        stalled = false
      },
      get: async () => sessionFixture(id, 'interrupted', 50, 5),
      active: async () => ({}),
    },
    permission: { create: async () => ({ effect: 'deny' }), list: async () => [] },
  } as unknown as OpenCodeClient
  const c = config()
  c.agentTimeoutMs = 20
  const agents = new Agents(c, async () => {}, client)
  await agents.create('verification', new AbortController().signal)
  const keepAlive = setTimeout(() => {}, 1_000)
  try {
    await assert.rejects(
      agents.run(id, 'deadline test', new AbortController().signal),
      (error) => error instanceof AgentRunError && error.outcome === 'limit-exhausted',
    )
  } finally {
    clearTimeout(keepAlive)
    stalled = false
  }
  assert.deepEqual(await agents.cleanup(), [])
  assert.deepEqual(canceled, [prompt])
  assert.equal(agents.usage().totals.tokens, 55)
  assert.equal(agents.usage().totals.complete, true)
})

test('wall-clock cancellation is distinct from a failed agent response', async () => {
  const f = fixture()
  f.runtime.agent = async (_session, _role, _input, signal) =>
    new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  const c = config()
  c.wallClockMs = 20 // Keep this controlled deadline test fast; CLI inputs have a 1s minimum.
  const keepAlive = setTimeout(() => {}, 1_000)
  try {
    const report = await runLoop(c, f.runtime)
    assert.equal(report.outcome, 'limit-exhausted')
    assert.equal(f.cleaned, true)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('timed-out commands retain their outcome rather than disappearing from the attempt', async () => {
  const f = fixture()
  f.runtime.command = async (name, attempt) => ({
    name,
    code: null,
    signal: 'SIGTERM',
    termination: 'timeout',
    failure: 'setup',
    startedAt: timestamp,
    finishedAt: timestamp,
    log: `${attempt.evidence}/timeout.log`,
  })
  const report = await runLoop(config(), f.runtime)
  assert.equal(report.outcome, 'limit-exhausted')
  assert.equal(report.attempts[0]!.commands[0]!.termination, 'timeout')
})

test('verify-only authorization and an existing evidence directory fail closed', async () => {
  assert.throws(() => config({ mode: 'verify' }), /must not authorize writableFiles/)
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'loop-report-')))
  const evidence = resolve(root, '.local/loop/existing')
  await mkdir(evidence, { recursive: true })
  const previous = '{"outcome":"proposed-pass","previousRun":true}'
  await writeFile(resolve(evidence, 'report.json'), previous)
  const c = config({ workspace: root, evidence })
  await assert.rejects(runLoop(c, localRuntime(c, '/unused-config')), /No new evidence directory/)
  assert.equal(await readFile(resolve(evidence, 'report.json'), 'utf8'), previous)
})

test('an approved contract alias cannot turn protected acceptance into a writable source target', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'loop-contract-alias-')))
  const source = 'packages/core/src/index.ts'
  await mkdir(resolve(root, 'packages/core/src'), { recursive: true })
  await writeFile(resolve(root, source), 'approved contract')
  const contract = resolve(root, 'approved.md')
  await symlink(resolve(root, source), contract)
  const file = resolve(root, 'config.json')
  const c = config({ workspace: root, contract, evidence: resolve(root, '.local/loop/run') })
  await writeFile(file, JSON.stringify(c))
  const runtime = localRuntime(c, file)
  let started = false
  runtime.createSession = async () => {
    started = true
    return 'ses_unexpected'
  }
  const report = await runLoop(c, runtime)
  assert.equal(report.outcome, 'setup-failure')
  assert.match(report.reason!, /cannot alias writable source/)
  assert.equal(started, false)
  assert.equal(await readFile(contract, 'utf8'), 'approved contract')
})

test('validated edit handoff cannot touch acceptance, traverse directories or follow links', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'loop-edits-')))
  const file = 'packages/core/src/index.ts'
  await mkdir(resolve(root, 'packages/core/src'), { recursive: true })
  await writeFile(resolve(root, file), 'original')
  await writeFile(resolve(root, 'acceptance.md'), 'approved')
  await symlink(resolve(root, 'acceptance.md'), resolve(root, 'packages/core/src/link.ts'))
  for (const path of [
    'acceptance.md',
    '../acceptance.md',
    'packages/core/src/link.ts',
    'packages/core/src/index.test.ts',
  ]) {
    await assert.rejects(applyEdits(root, [file, path], [{ path, content: 'changed' }], []))
  }
  assert.equal(await readFile(resolve(root, 'acceptance.md'), 'utf8'), 'approved')
  await applyEdits(root, [file], [{ path: file, content: 'authorized' }], [])
  assert.equal(await readFile(resolve(root, file), 'utf8'), 'authorized')
})

test(
  'macOS sandbox enforces writes, link aliases, descendants, signals and network denial',
  {
    skip: process.platform !== 'darwin' || process.env.LOCAL_LOOP_SANDBOXED === '1',
  },
  async () => {
    const root = await realpath(await mkdtemp(resolve(tmpdir(), 'loop-sandbox-')))
    const result = await validateSandbox(root)
    assert.ok(result.probes.includes('hardlink'))
    const scratch = resolve(root, 'scratch')
    const [command, args] = sandboxCommand(process.execPath, ['-e', 'process.exit(0)'], {
      readable: [root],
      writable: [scratch],
    })
    await promisify(execFile)(command, args, { env: cleanEnvironment(scratch) })
  },
)

test(
  'real isolated checks, artifact production and UAT accept controlled agent handoffs',
  {
    skip: process.env.LOOP_TEST_RUNTIME !== '1',
    timeout: 600_000,
  },
  async (t) => {
    const root = await realpath(process.cwd())
    const parent = resolve(root, '.local/loop')
    await mkdir(parent, { recursive: true })
    const inputs = await mkdtemp(resolve(parent, 'runtime-inputs-'))
    const contract = resolve(inputs, 'contract.md')
    await writeFile(
      contract,
      'Keep the existing recipe behavior: empty state, create/list, reload persistence, and rejection of empty/whitespace titles without a new recipe. All four agreed UAT scenarios must pass.',
    )
    const c = config({
      mode: 'verify',
      billing: 'chatgpt-subscription',
      model: { providerID: 'openai', modelID: 'gpt-6.1-sol' },
      writableFiles: [],
      contextFiles: ['packages/core/src/index.ts'],
      workspace: root,
      contract,
      evidence: resolve(inputs, 'run'),
      scenarios: [
        'fresh application shows an empty recipe state',
        'create a recipe and see it listed',
        'recipe remains visible after reload',
        'reject an empty title without creating a recipe',
      ],
    })
    const file = resolve(inputs, 'config.json')
    await writeFile(file, JSON.stringify(c))
    let id = 0
    const runtime = localRuntime(c, file)
    runtime.createSession = async () => `ses_controlled_${++id}`
    runtime.agent = async (_session, role) =>
      role === 'implementation'
        ? {
            status: 'ready',
            rationale: 'No source changes needed for the existing approved recipe contract',
            files: [],
          }
        : role === 'verification'
          ? { ...approve, coveredScenarios: c.scenarios }
          : reviewApprove
    const report = await runLoop(c, runtime)
    t.diagnostic(`Loop evidence: ${c.evidence}`)
    assert.equal(report.outcome, 'proposed-pass', `${report.reason}; evidence: ${c.evidence}`)
    assert.equal(report.agentUsage?.billing, 'chatgpt-subscription')
    assert.equal(report.agentUsage?.totals.estimatedUsd, null)
    assert.match(await readFile(resolve(c.evidence, 'report.md'), 'utf8'), /USD unpriced/)
    const context = JSON.parse(await readFile(resolve(c.evidence, 'context.json'), 'utf8')) as {
      reviewGuidance: Record<string, Record<string, string>>
      adrs: Record<string, string>
    }
    assert.ok(
      context.reviewGuidance['security-review']?.['.agents/skills/security-review/SKILL.md'],
    )
    assert.ok(
      context.adrs['doc/adr/0008-bound-local-agent-work-with-tool-denial-and-process-isolation.md'],
    )
    assert.equal(report.attempts[0]!.commands.length, 5)
    assert.equal(report.attempts[0]!.implementationSession, undefined)

    // Test hostile candidate behavior using ONLY owned fixtures, never real source/tests.
    const fixture = resolve(inputs, 'hostile-artifacts')
    await cp(report.finalCandidate!.path, fixture, { recursive: true })
    await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    await rename(resolve(fixture, 'migrate.cjs'), resolve(fixture, 'migrate.original.cjs'))
    await writeFile(
      resolve(fixture, 'migrate.cjs'),
      `
    const fs = require('node:fs');
    for (const path of ${JSON.stringify([contract, resolve(fixture, 'api.cjs'), resolve(c.evidence, 'contract.md')])}) {
      let denied = false; try { fs.writeFileSync(path, 'tampered') } catch (error) { denied = ['EPERM','EACCES'].includes(error.code) }
      if (!denied) throw new Error('Protection failed: ' + path);
    }
    console.log('Protected acceptance inputs and candidate writes denied');
    const socket = require('node:net').connect({host:'127.0.0.1',port:9});
    socket.on('error', error => {
      if (!['EPERM','EACCES'].includes(error.code)) throw new Error('Unrelated outbound connection not denied');
      console.log('Unrelated outbound connection denied; only the disposable database is reachable');
      require('./migrate.original.cjs');
    });
    socket.on('connect', () => { throw new Error('Unrelated endpoint reachable') });
  `,
    )
    const artifacts = (await import(resolve(root, 'packages/uat/artifacts.mjs'))) as {
      fingerprint(path: string): Promise<unknown>
    }
    await writeFile(
      resolve(fixture, 'manifest.json'),
      JSON.stringify({
        version: 1,
        builtAt: timestamp,
        files: await artifacts.fingerprint(fixture),
      }),
    )
    const scratch = resolve(inputs, 'hostile-scratch')
    await mkdir(scratch)
    const output = resolve(inputs, 'hostile-uat')
    await promisify(execFile)(
      process.execPath,
      [resolve(root, 'packages/uat/run.mjs'), fixture, output],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          UAT_SANDBOX: '1',
          UAT_SANDBOX_SCRATCH: scratch,
        },
        timeout: 240_000,
      },
    )
    const hostileResult = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8')) as {
      outcome: string
    }
    assert.equal(hostileResult.outcome, 'passed')
    assert.match(
      await readFile(resolve(output, 'migrations.log'), 'utf8'),
      /candidate writes denied/,
    )
    assert.match(await readFile(contract, 'utf8'), /Keep the existing/)
  },
)
