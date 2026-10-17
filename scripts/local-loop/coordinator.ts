import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { checkPolicy } from './check-policy.ts'
import {
  candidateSchema,
  commandSchema,
  completeUat,
  implementationSchema,
  sameSet,
  uatSchema,
  verifierSchema,
  reviewSchema,
  type Attempt,
  type Command,
  type Config,
  type Outcome,
  type Report,
  type State,
  type Role,
  type UsageReport,
} from './contracts.ts'

// The concrete adapter owns filesystem/process/session authority. Tests replace that
// seam, not scheduling or success gates.
export type Runtime = {
  initialize(signal: AbortSignal): Promise<Report['contract']>
  assertProtected(): Promise<void>
  createSession(role: Role, signal: AbortSignal): Promise<string>
  agent(session: string, role: Role, input: unknown, signal: AbortSignal): Promise<unknown>
  apply(files: { path: string; content: string }[]): Promise<void>
  command(
    name: 'lint' | 'typecheck' | 'test:unit' | 'build:uat' | 'uat',
    attempt: Attempt,
    signal: AbortSignal,
  ): Promise<unknown>
  candidate(attempt: Attempt): Promise<unknown>
  uat(attempt: Attempt): Promise<unknown>
  save(report: Report): Promise<void>
  cleanup(): Promise<string[]>
  usage?(): UsageReport
}

const transitions: Record<State, State[]> = {
  implementation: ['checks', 'stopped'],
  checks: ['review', 'stopped'],
  review: ['build', 'repair', 'stopped'],
  build: ['uat', 'stopped'],
  uat: ['verification', 'stopped'],
  verification: ['repair', 'stopped'],
  repair: ['implementation', 'stopped'],
  stopped: [],
}

export class LoopStop extends Error {
  outcome: Outcome
  constructor(outcome: Outcome, message: string) {
    super(message)
    this.outcome = outcome
  }
}

export async function runLoop(
  config: Config,
  runtime: Runtime,
  external = new AbortController().signal,
) {
  const deadline = AbortSignal.timeout(config.wallClockMs)
  const signal = AbortSignal.any([external, deadline])
  const report: Report = {
    issue: config.issue,
    mode: config.mode,
    contract: { reference: config.contract, snapshot: '', sha256: '' },
    startedAt: new Date().toISOString(),
    state: config.mode === 'verify' ? 'checks' : 'implementation',
    transitions: [],
    attempts: [],
    cleanupErrors: [],
    approval: 'Human approval required; no authorization to ship',
  }
  const stop = (outcome: Outcome, reason: string): never => {
    throw new LoopStop(outcome, reason)
  }
  async function checkpoint() {
    if (external.aborted) stop('interrupted', 'Operator interrupted the run')
    if (deadline.aborted) stop('limit-exhausted', 'Wall-clock limit exhausted')
    await runtime.assertProtected()
    report.agentUsage = runtime.usage?.()
    await runtime.save(report)
  }
  async function enter(state: State) {
    if (!transitions[report.state].includes(state))
      throw new Error(`Invalid transition ${report.state} -> ${state}`)
    report.state = state
    report.transitions.push({ state, at: new Date().toISOString() })
    await checkpoint()
  }
  async function command(name: Parameters<Runtime['command']>[0], attempt: Attempt) {
    const outcome = commandSchema.parse(await runtime.command(name, attempt, signal))
    if (outcome.name !== name) stop('setup-failure', `Command identity mismatch: ${name}`)
    attempt.commands.push(outcome)
    await checkpoint()
    if (outcome.termination === 'timeout') stop('limit-exhausted', `${name} command timed out`)
    if (outcome.termination === 'interrupted') stop('interrupted', `${name} was interrupted`)
    return outcome
  }
  function succeeded(command: Command) {
    return command.code === 0 && command.signal === null && !command.failure
  }
  let failureSignature: string | undefined
  let feedback: unknown = null
  const independentSessions = new Set<string>()
  async function freshSession(role: Role, implementationSession?: string) {
    const id = await runtime.createSession(role, signal)
    if (id === implementationSession || independentSessions.has(id))
      stop('agent-error', 'Review/verifier session was not fresh and independent')
    independentSessions.add(id)
    return id
  }
  async function repair(
    attempt: Attempt,
    signature: string,
    rationale: string,
    nextFeedback: unknown,
  ) {
    attempt.repairRationale = rationale
    attempt.outcome = 'product-failure'
    attempt.finishedAt = new Date().toISOString()
    if (config.mode === 'verify')
      stop(
        'product-failure',
        `Read-only verification found defects: ${rationale}; repair together and start a new run`,
      )
    if (signature === failureSignature)
      stop('limit-exhausted', 'Repeated identical failure; human diagnosis required')
    failureSignature = signature
    if (attempt.number === config.maxAttempts)
      stop('limit-exhausted', 'Candidate attempt limit exhausted')
    feedback = nextFeedback
    await enter('repair')
    await enter('implementation')
  }
  try {
    signal.throwIfAborted()
    report.contract = await runtime.initialize(signal)
    await checkpoint()
    const implementationSession =
      config.mode === 'implement'
        ? await runtime.createSession('implementation', signal)
        : undefined
    for (let number = 1; number <= (config.mode === 'verify' ? 1 : config.maxAttempts); number++) {
      const attempt: Attempt = {
        number,
        startedAt: new Date().toISOString(),
        implementationSession,
        evidence: resolve(config.evidence, `attempt-${number}`),
        commands: [],
        reviews: [],
      }
      report.attempts.push(attempt)
      delete report.finalCandidate
      await checkpoint()
      if (implementationSession) {
        let implementation: ReturnType<typeof implementationSchema.parse>
        try {
          implementation = implementationSchema.parse(
            await runtime.agent(
              implementationSession,
              'implementation',
              { feedback, contract: report.contract },
              signal,
            ),
          )
        } catch (error) {
          if (error instanceof LoopStop || signal.aborted) throw error
          throw new LoopStop(
            'agent-error',
            `Invalid/missing implementation output: ${String(error)}`,
          )
        }
        attempt.implementation = implementation
        await checkpoint()
        if (implementation.status === 'needs-human') stop('needs-human', implementation.rationale)
        await runtime.apply(implementation.files)
        await checkpoint()
        await enter('checks')
      }
      for (const name of ['lint', 'typecheck', 'test:unit'] as const) {
        const result = await command(name, attempt)
        // Existing check commands have no structured product/setup attribution.
        // Never guess that a test-environment failure authorizes source rewrites.
        if (!succeeded(result))
          stop(
            result.code === null || result.signal || result.failure
              ? 'setup-failure'
              : 'needs-human',
            `${name} failed without product/setup attribution; inspect its log before authorizing repair`,
          )
      }
      await enter('review')
      let rejected = false
      for (const role of [
        'code-review',
        'security-review',
        ...(config.architectureReview ? ['architecture-review'] : []),
      ] as Role[]) {
        const session = await freshSession(role, implementationSession)
        const review: Attempt['reviews'][number] = { role, session }
        attempt.reviews.push(review)
        await checkpoint()
        let result: ReturnType<typeof reviewSchema.parse>
        try {
          result = reviewSchema.parse(
            await runtime.agent(session, role, { commands: attempt.commands }, signal),
          )
        } catch (error) {
          if (error instanceof LoopStop || signal.aborted) throw error
          throw new LoopStop('agent-error', `Invalid/missing ${role} output: ${String(error)}`)
        }
        review.result = result
        await checkpoint()
        if (result.decision === 'needs-human') stop('needs-human', result.findings.join('\n'))
        if (result.decision === 'uncertain')
          stop('verifier-uncertainty', `${role}: ${result.findings.join('\n')}`)
        if (result.decision === 'product-failure') {
          if (!result.repairRationale.trim())
            stop('verifier-uncertainty', `${role} has no actionable product repair rationale`)
          await repair(
            attempt,
            JSON.stringify({ role, findings: result.findings }),
            result.repairRationale,
            { role, ...result },
          )
          rejected = true
          break
        }
      }
      if (rejected) continue
      await enter('build')
      if (!succeeded(await command('build:uat', attempt)))
        stop('setup-failure', 'Artifact production failed')
      attempt.candidate = candidateSchema.parse(await runtime.candidate(attempt))
      if (
        report.attempts
          .slice(0, -1)
          .some((previous) => previous.candidate?.path === attempt.candidate?.path)
      )
        stop('setup-failure', 'Candidate directory was reused')
      report.finalCandidate = attempt.candidate
      await enter('uat')
      const acceptance = await command('uat', attempt)
      attempt.uat = await runtime.uat(attempt)
      // Setup reports can legitimately lack an artifact identity/scenarios.
      if (
        typeof attempt.uat === 'object' &&
        attempt.uat !== null &&
        'outcome' in attempt.uat &&
        attempt.uat.outcome === 'setup-error'
      )
        stop('setup-failure', 'UAT setup failed; application repair is not authorized')
      const uat = uatSchema.parse(attempt.uat)
      const identity = candidateSchema.parse(await runtime.candidate(attempt))
      if (identity.sha256 !== attempt.candidate.sha256 || identity.path !== attempt.candidate.path)
        stop('protected-input-mutation', 'Candidate identity changed during acceptance')
      if (
        !completeUat(uat, attempt.candidate, config.scenarios) ||
        uat.evidence !== resolve(attempt.evidence, 'uat')
      )
        stop('setup-failure', 'UAT evidence is incomplete, mismatched, or cleanup failed')
      const machinePass =
        uat.outcome === 'passed' && uat.scenarios.every((scenario) => scenario.passed)
      if (
        acceptance.signal !== null ||
        (machinePass ? !succeeded(acceptance) : acceptance.code !== 1) ||
        (uat.outcome === 'expectation-failed' && uat.scenarios.every((scenario) => scenario.passed))
      )
        stop('setup-failure', 'UAT exit status and report disagree')
      await enter('verification')
      attempt.verifierSession = await freshSession('verification', implementationSession)
      let verification: ReturnType<typeof verifierSchema.parse>
      try {
        verification = verifierSchema.parse(
          await runtime.agent(
            attempt.verifierSession,
            'verification',
            {
              contract: report.contract,
              candidate: attempt.candidate,
              commands: attempt.commands,
              reviews: attempt.reviews,
              checkPolicy: checkPolicy(config.scenarios),
              uat,
            },
            signal,
          ),
        )
      } catch (error) {
        if (error instanceof LoopStop || signal.aborted) throw error
        throw new LoopStop('agent-error', `Invalid/missing verifier output: ${String(error)}`)
      }
      attempt.verifier = verification
      attempt.finishedAt = new Date().toISOString()
      await checkpoint()
      if (verification.decision === 'needs-human')
        stop('needs-human', verification.findings.join('\n'))
      if (
        verification.decision === 'uncertain' ||
        !sameSet(verification.coveredScenarios, config.scenarios)
      )
        stop(
          'verifier-uncertainty',
          'Verifier cannot establish complete approved-contract coverage',
        )
      if (machinePass && verification.decision === 'approve')
        stop(
          'proposed-pass',
          'Complete checks and independent review passed; human approval required',
        )
      if (!machinePass && verification.decision === 'approve')
        stop('product-failure', 'Verifier approval cannot override failed deterministic acceptance')
      if (!verification.repairRationale.trim())
        stop('verifier-uncertainty', 'Product failure has no actionable repair rationale')
      const signature = createHash('sha256')
        .update(
          JSON.stringify({
            failures: uat.scenarios
              .filter((scenario) => !scenario.passed)
              .map((scenario) => scenario.name),
            findings: verification.findings,
          }),
        )
        .digest('hex')
      await repair(attempt, signature, verification.repairRationale, {
        candidate: attempt.candidate,
        uat,
        findings: verification.findings,
        rationale: verification.repairRationale,
      })
    }
  } catch (error) {
    report.outcome = external.aborted
      ? 'interrupted'
      : deadline.aborted
        ? 'limit-exhausted'
        : error instanceof LoopStop
          ? error.outcome
          : 'setup-failure'
    report.reason = String(error instanceof Error ? error.message : error)
  } finally {
    try {
      report.cleanupErrors = await runtime.cleanup()
    } catch (error) {
      report.cleanupErrors.push(String(error))
    }
    if (report.cleanupErrors.length) {
      if (report.outcome === 'proposed-pass' || !report.outcome) report.outcome = 'setup-failure'
      report.reason = `${report.reason ?? ''}; cleanup incomplete: inspect cleanup errors before starting another run`
    }
    report.state = 'stopped'
    report.transitions.push({ state: 'stopped', at: new Date().toISOString() })
    report.finishedAt = new Date().toISOString()
    const last = report.attempts.at(-1)
    if (last) {
      last.outcome = report.outcome
      if (!last.finishedAt) last.finishedAt = report.finishedAt
    }
    report.agentUsage = runtime.usage?.()
    await runtime.save(report)
  }
  return report
}
