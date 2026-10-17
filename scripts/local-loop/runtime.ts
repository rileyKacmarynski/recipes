import { spawn, execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import { AgentRunError, Agents } from './agents.ts'
import { LoopStop, type Runtime } from './coordinator.ts'
import { type Attempt, type Config } from './contracts.ts'
import { cleanEnvironment, sandboxCommand, validateSandbox } from './sandbox.mjs'
import { createReviewHandoff, loadReviewGuidance, type ReviewGuidance } from './review-guidance.ts'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function json(path: string, data: unknown) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n')
}
async function inputHash(path: string) {
  try {
    return hash(await readFile(path))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '(missing)'
    throw error
  }
}
const sourcePath =
  /^packages\/(web|api|core)\/src\/(?!.*(?:^|\/)(?:__tests__|testing)(?:\/|\.))(?!.*\.(?:test|spec|gen)\.)[^\s]+\.(?:ts|tsx|css)$/

export async function safeFile(root: string, path: string) {
  if (
    isAbsolute(path) ||
    path.split('/').some((segment) => ['', '.', '..'].includes(segment)) ||
    path.includes('\\')
  )
    throw new LoopStop('protected-input-mutation', `Unsafe source/context path: ${path}`)
  const file = resolve(root, path)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.nlink !== 1 || (await realpath(file)) !== file)
    throw new LoopStop(
      'protected-input-mutation',
      `Symlink, hardlink, or non-regular file refused: ${path}`,
    )
  return file
}

export async function applyEdits(
  root: string,
  writableFiles: string[],
  edits: { path: string; content: string }[],
  protectedPaths: string[],
) {
  const seen = new Set<string>()
  // Validate the entire handoff before the first write.
  for (const edit of edits) {
    if (!sourcePath.test(edit.path) || !writableFiles.includes(edit.path) || seen.has(edit.path))
      throw new LoopStop('protected-input-mutation', `Unauthorized or duplicate edit: ${edit.path}`)
    seen.add(edit.path)
    const path = await safeFile(root, edit.path)
    if (protectedPaths.includes(path))
      throw new LoopStop('protected-input-mutation', 'An approved input cannot be a repair target')
  }
  for (const edit of edits) {
    const file = await safeFile(root, edit.path)
    // O_NOFOLLOW prevents a final-component symlink swap. The workspace is single-writer;
    // concurrent human/host changes are outside the sandbox and cause snapshot failure.
    const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1)
        throw new LoopStop('protected-input-mutation', `Repair target changed: ${edit.path}`)
      await handle.truncate(0)
      await handle.writeFile(edit.content)
    } finally {
      await handle.close()
    }
  }
}

export function localRuntime(config: Config, configFile: string): Runtime {
  const root = config.workspace
  const evidence = config.evidence
  let currentAttempt: Attempt | undefined
  let lockOwned = false
  let evidenceOwned = false
  const lock = resolve(root, '.local/loop/workspace.lock')
  const protectedInputs = new Map<string, string>()
  let approvedContract = ''
  let context: Record<string, string> = {}
  let instructions: Record<string, string> = {}
  let reviewGuidance: ReviewGuidance | undefined
  let adrs: Record<string, string> = {}
  let baselineDiff = ''
  const cleanupErrors: string[] = []
  const agents = new Agents(config, async (ids) => {
    await json(resolve(evidence, 'sessions.json'), ids)
    await json(resolve(evidence, 'agent-usage.json'), agents.usage())
  })
  const corepack = resolve(process.env.COREPACK_HOME ?? resolve(homedir(), '.cache/node/corepack'))
  const outputPaths = [
    'packages/web/dist',
    'packages/web/.tanstack',
    'packages/web/src/routeTree.gen.ts',
    'packages/web/tsconfig.tsbuildinfo',
    'packages/api/dist',
    'packages/core/dist',
    'packages/db/dist',
    // Only disposable compiler/test caches, never dependency code or manifests.
    ...['web', 'api', 'core', 'db'].flatMap((pkg) =>
      [`.vite`, `.vite-temp`].map((cache) => `packages/${pkg}/node_modules/${cache}`),
    ),
  ].map((path) => resolve(root, path))
  const generated = resolve(root, 'packages/web/src/routeTree.gen.ts')

  return {
    async initialize(signal) {
      if ((await realpath(root)) !== root)
        throw new Error('Workspace must be a canonical absolute directory')
      if (!evidence.startsWith(resolve(root, '.local/loop') + sep) || evidence === lock)
        throw new Error('Evidence must be a NEW directory under <workspace>/.local/loop/')
      let ancestor = dirname(evidence)
      while (true) {
        try {
          if ((await realpath(ancestor)) !== ancestor)
            throw new Error('Evidence parent must not contain symlinks')
          break
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          ancestor = dirname(ancestor)
        }
      }
      await mkdir(dirname(evidence), { recursive: true })
      if ((await realpath(dirname(evidence))) !== dirname(evidence))
        throw new Error('Evidence parent must not contain symlinks')
      await mkdir(evidence, { mode: 0o700 })
      evidenceOwned = true
      await json(resolve(evidence, 'config.json'), config)
      const handle = await open(lock, 'wx')
      lockOwned = true
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, evidence }))
      } finally {
        await handle.close()
      }
      if (new Set(config.writableFiles).size !== config.writableFiles.length)
        throw new Error('Duplicate writable files')
      for (const path of config.writableFiles) {
        if (!sourcePath.test(path))
          throw new Error(
            `Only existing non-test application source files may be approved: ${path}`,
          )
        await safeFile(root, path)
      }
      if (!config.scenarios.length || new Set(config.scenarios).size !== config.scenarios.length)
        throw new Error('Scenario names must be unique')
      approvedContract = await readFile(config.contract, 'utf8')
      if (!approvedContract.trim()) throw new Error('Approved contract is empty')
      for (const path of [config.contract, configFile]) {
        const canonical = await realpath(path)
        if (config.writableFiles.some((relative) => resolve(root, relative) === canonical))
          throw new Error('Contract or run config cannot alias writable source')
      }
      await writeFile(resolve(evidence, 'contract.md'), approvedContract)
      const tracked = execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root },
      )
        .toString()
        .split('\0')
        .filter(Boolean)
      baselineDiff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'], {
        cwd: root,
        maxBuffer: 5_000_000,
      }).toString()
      for (const relative of tracked) {
        const path = resolve(root, relative)
        if (!config.writableFiles.includes(relative) && path !== generated) {
          const digest = await inputHash(path)
          protectedInputs.set(path, digest)
          if (digest !== '(missing)') {
            const canonical = await realpath(path)
            if (config.writableFiles.some((source) => resolve(root, source) === canonical))
              throw new Error(`Protected input aliases writable source: ${relative}`)
            protectedInputs.set(canonical, digest)
          }
        }
      }
      for (const path of [config.contract, configFile]) {
        const digest = await inputHash(path)
        protectedInputs.set(path, digest)
        protectedInputs.set(await realpath(path), digest)
      }
      const guidance = await loadReviewGuidance(root)
      reviewGuidance = guidance.byRole
      adrs = guidance.adrs
      // Explicit registration also protects guidance/ADRs excluded by Git ignore rules.
      for (const [relative, content] of Object.entries(guidance.files)) {
        const path = resolve(root, relative)
        const canonical = await realpath(path)
        if (config.writableFiles.some((source) => resolve(root, source) === canonical))
          throw new Error(`Review guidance aliases writable source: ${relative}`)
        protectedInputs.set(path, hash(content))
        protectedInputs.set(canonical, hash(content))
      }
      await json(resolve(evidence, 'protected-inputs.json'), Object.fromEntries(protectedInputs))
      const changed = execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root })
        .toString()
        .split('\0')
        .filter(Boolean)
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
        cwd: root,
      })
        .toString()
        .split('\0')
        .filter(Boolean)
      const reviewFiles = [...changed, ...untracked].filter(
        (path) =>
          /^(?:packages|scripts)\/.*\.(?:ts|tsx|mts|cts|mjs|json|css)$/.test(path) &&
          tracked.includes(path),
      )
      context = Object.fromEntries(
        await Promise.all(
          [...new Set([...config.contextFiles, ...config.writableFiles, ...reviewFiles])].map(
            async (path) => {
              if (
                protectedInputs.get(resolve(root, path)) === '(missing)' &&
                !config.contextFiles.includes(path)
              )
                return [path, '[Deleted in the approved workspace; see baselineDiff]']
              return [path, await readFile(await safeFile(root, path), 'utf8')]
            },
          ),
        ),
      )
      for (const path of [
        'AGENTS.md',
        '.agents/skills/architecture-preferences/SKILL.md',
        '.agents/skills/testing-preferences/SKILL.md',
        ...([...config.writableFiles, ...reviewFiles].some((path) =>
          path.startsWith('packages/web/'),
        )
          ? [
              '.agents/skills/frontend-ui-preferences/SKILL.md',
              '.agents/skills/accessibility-quality/SKILL.md',
            ]
          : []),
      ])
        instructions[path] = await readFile(resolve(root, path), 'utf8')
      await json(resolve(evidence, 'context.json'), {
        context,
        instructions,
        reviewGuidance,
        adrs,
        baselineDiff,
      })
      const probes = resolve(evidence, 'isolation')
      await mkdir(probes)
      await json(resolve(evidence, 'isolation.json'), await validateSandbox(probes))
      signal.throwIfAborted()
      return {
        reference: config.contract,
        snapshot: resolve(evidence, 'contract.md'),
        sha256: hash(approvedContract),
      }
    },
    async assertProtected() {
      for (const [path, expected] of protectedInputs) {
        const actual = await inputHash(path)
        if (actual !== expected)
          throw new LoopStop('protected-input-mutation', `Approved input changed: ${path}`)
      }
    },
    async createSession(role, signal) {
      await agents.connect(signal)
      return agents.create(role, signal)
    },
    async agent(session, role, input, signal) {
      if (!currentAttempt) throw new Error('Missing active attempt')
      await mkdir(currentAttempt.evidence, { recursive: true })
      const reviewer =
        role === 'implementation' || role === 'verification'
          ? undefined
          : createReviewHandoff(role, reviewGuidance)
      const roleInstructions =
        role === 'implementation'
          ? 'Implement only the approved contract. You have no tools. Return ONLY JSON {"status":"ready"|"needs-human","rationale":string,"files":[{"path":string,"content":string}]}. Files are full replacements of existing approved writable files, not patches. Do not edit tests, expectations, configuration, tools, or generated files. Ask for human input using needs-human if context or authorization is insufficient. Repair only failures attributable to the product; never weaken acceptance.'
          : 'Independently assess the approved contract against the exact candidate and deterministic evidence. You have no tools. Return ONLY JSON {"decision":"approve"|"product-failure"|"uncertain"|"needs-human","findings":string[],"coveredScenarios":string[],"repairRationale":string}. Missing evidence, skipped checks, coverage gaps, ambiguous requirements or changes to acceptance require uncertainty/human input. Do not approve merely because tools are green. Machine failures cannot be overridden. Give actionable product-only repair rationale when justified; do not perform repairs. Binary attachments are retained but not supplied to you; do not claim to have inspected them.'
      const sources: Record<string, string> = { ...context }
      for (const path of config.writableFiles)
        sources[path] = await readFile(await safeFile(root, path), 'utf8')
      const logs: Record<string, string> = {}
      const omittedLogs: { path: string; reason: string }[] = []
      for (const command of currentAttempt.commands) {
        if (command.name === 'test:unit' || command.code !== 0 || command.signal || command.failure)
          logs[command.name] = await readFile(command.log, 'utf8')
        else
          omittedLogs.push({
            path: command.log,
            reason: 'Successful command; exit/timing evidence supplied, full log retained locally',
          })
      }
      if (role === 'verification') {
        const productFailed = z
          .object({ uat: z.object({ outcome: z.literal('expectation-failed') }) })
          .safeParse(input).success
        for (const name of [
          'summary.txt',
          'playwright.log',
          ...(productFailed ? ['api.log', 'migrations.log', 'frontend.log'] : []),
        ]) {
          try {
            logs[`uat/${name}`] = await readFile(
              resolve(currentAttempt.evidence, 'uat', name),
              'utf8',
            )
          } catch (error) {
            logs[`uat/${name}`] = `Unavailable: ${String(error)}`
          }
        }
      }
      const request = {
        // Stable shared prefix can help same-model/provider caching; never assume a cache hit.
        issue: config.issue,
        approvedContract,
        adrs,
        requiredScenarios: config.scenarios,
        ...(reviewer ?? { roleInstructions }),
        responseTarget: {
          tokens: config.budget.targetOutputTokensPerCall,
          guidance:
            'Aim for this response size while returning the required complete JSON. This is a response target, not a provider-enforced token cap.',
        },
        ...(role !== 'verification'
          ? {
              instructions: Object.fromEntries(
                Object.entries(instructions).filter(([path]) => !reviewer?.reviewGuidance[path]),
              ),
              sources,
              baselineDiff,
              changes: config.writableFiles.map((path) => ({
                path,
                before: context[path],
                afterSource: path,
              })),
              ...(role === 'implementation' ? { writableFiles: config.writableFiles } : {}),
            }
          : {}),
        logs,
        omittedLogs,
        input,
      }
      // Explicitly retain exactly what the model saw; oversized evidence escalates instead of silently truncating.
      const serialized = JSON.stringify(request)
      if (Buffer.byteLength(serialized) > 500_000)
        throw new LoopStop('needs-human', 'Agent handoff exceeds 500 KB; narrow approved context')
      await json(resolve(currentAttempt.evidence, `${role}-input.json`), request)
      await writeFile(resolve(currentAttempt.evidence, `${role}-prompt.txt`), serialized)
      try {
        const response = await agents.run(session, serialized, signal, currentAttempt.number)
        await json(resolve(currentAttempt.evidence, `${role}-response.json`), response)
        return response.output
      } catch (error) {
        await json(resolve(currentAttempt.evidence, `${role}-error.json`), {
          error: String(error),
          ...(error instanceof AgentRunError ? { details: error.details } : {}),
        })
        throw error
      }
    },
    apply: (files) => {
      if (config.mode === 'verify')
        throw new LoopStop('protected-input-mutation', 'Verify-only mode cannot apply edits')
      return applyEdits(root, config.writableFiles, files, [...protectedInputs.keys()])
    },
    usage: () => agents.usage(),
    async command(name, attempt, signal) {
      await mkdir(attempt.evidence, { recursive: true })
      const scratch = resolve(attempt.evidence, `${name.replace(':', '-')}-scratch`)
      await mkdir(scratch)
      const startedAt = new Date().toISOString()
      const log = resolve(attempt.evidence, `${name.replace(':', '-')}.log`)
      const parameters =
        name === 'build:uat'
          ? [name, resolve(attempt.evidence, 'artifacts')]
          : name === 'uat'
            ? [name, attempt.candidate!.path, resolve(attempt.evidence, 'uat')]
            : [name]
      const runtimeScratch = resolve(scratch, 'runtime')
      await mkdir(runtimeScratch)
      const env: NodeJS.ProcessEnv =
        name === 'uat'
          ? {
              // Trusted UAT owns Docker/browser provisioning. Only its candidate children are sandboxed.
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              DOCKER_HOST: process.env.DOCKER_HOST,
              DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
              DOCKER_CONFIG: process.env.DOCKER_CONFIG,
              UAT_SANDBOX: '1',
              UAT_SANDBOX_SCRATCH: runtimeScratch,
            }
          : {
              ...cleanEnvironment(scratch),
              COREPACK_HOME: corepack,
              UAT_CHECKS_DIRECTORY: resolve(scratch, 'uat-checks'),
            }
      const [executable, args] =
        name === 'uat'
          ? [process.execPath, [resolve(root, 'packages/uat/run.mjs'), ...parameters.slice(1)]]
          : sandboxCommand('pnpm', parameters, {
              readable: [root, dirname(process.execPath), corepack],
              hidden: [
                resolve(root, '.local'),
                resolve(root, '.git'),
                ...['.env', '.env.local', '.env.production', '.env.production.local'].map((path) =>
                  resolve(root, path),
                ),
              ],
              writable: [
                scratch,
                ...outputPaths,
                ...(name === 'build:uat' ? [resolve(attempt.evidence, 'artifacts')] : []),
              ],
            })
      const output = await open(log, 'wx')
      const timeout = AbortSignal.timeout(config.commandTimeoutMs)
      const bounded = AbortSignal.any([signal, timeout])
      let timer: NodeJS.Timeout | undefined
      let interrupted = false
      let child: ReturnType<typeof spawn> | undefined
      const interrupt = () => {
        interrupted = true
        if (!child?.pid) return
        // Let UAT handle SIGTERM and own its runtime/container teardown. Never kill its group.
        try {
          if (name === 'uat') child.kill('SIGTERM')
          else process.kill(-child.pid, 'SIGTERM')
        } catch {}
        timer = setTimeout(
          () => {
            try {
              if (name === 'uat') {
                cleanupErrors.push(
                  `UAT pid ${child!.pid} exceeded its 90-second cleanup allowance; inspect retained UAT resource/cleanup evidence`,
                )
                child!.kill('SIGKILL')
              } else process.kill(-child!.pid!, 'SIGKILL')
            } catch {}
          },
          name === 'uat' ? 90_000 : 3_000,
        )
      }
      try {
        bounded.throwIfAborted()
        child = spawn(executable, args, {
          cwd: root,
          env,
          detached: name !== 'uat',
          stdio: ['ignore', output.fd, output.fd],
        })
        bounded.addEventListener('abort', interrupt, { once: true })
        if (bounded.aborted) interrupt()
        const result = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            child!.once('error', reject)
            child!.once('exit', (code, signal) => resolve({ code, signal }))
          },
        )
        return {
          name,
          ...result,
          startedAt,
          finishedAt: new Date().toISOString(),
          log,
          ...(interrupted
            ? { failure: 'setup', termination: signal.aborted ? 'interrupted' : 'timeout' }
            : {}),
        }
      } catch (error) {
        return {
          name,
          code: null,
          signal: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          log,
          failure: 'setup',
          termination: signal.aborted ? 'interrupted' : timeout.aborted ? 'timeout' : 'spawn-error',
          error: String(error),
        }
      } finally {
        bounded.removeEventListener('abort', interrupt)
        clearTimeout(timer)
        if (name !== 'uat' && child?.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {}
        }
        await output.close()
      }
    },
    async candidate(attempt) {
      // Reuse the producer/UAT identity implementation, without duplicating its manifest rules.
      const verifier = resolve(root, 'packages/uat/artifacts.mjs')
      const module = (await import(verifier)) as { verifyArtifacts(path: string): Promise<unknown> }
      const path = resolve(attempt.evidence, 'artifacts')
      const manifest = z.object({ sha256: z.string() }).parse(await module.verifyArtifacts(path))
      return { path, sha256: manifest.sha256 }
    },
    async uat(attempt) {
      return JSON.parse(
        await readFile(resolve(attempt.evidence, 'uat/report.json'), 'utf8'),
      ) as unknown
    },
    async save(report) {
      currentAttempt = report.attempts.at(-1)
      if (!evidenceOwned)
        throw new Error(
          'No new evidence directory was created; no report was written. Choose a new canonical directory under .local/loop/.',
        )
      await json(resolve(evidence, 'report.json.tmp'), report)
      await rename(resolve(evidence, 'report.json.tmp'), resolve(evidence, 'report.json'))
      for (const attempt of report.attempts) {
        await mkdir(attempt.evidence, { recursive: true })
        await json(resolve(attempt.evidence, 'attempt.json'), {
          contract: report.contract,
          ...attempt,
          agentCalls: report.agentUsage?.calls.filter((call) => call.attempt === attempt.number),
        })
      }
      await writeFile(
        resolve(evidence, 'report.md'),
        [
          '# Local implementation–verification result',
          '',
          `Outcome: **${report.outcome ?? report.state}**`,
          report.reason ?? '',
          `Mode: ${report.mode}`,
          ...(report.agentUsage
            ? [
                `Billing: ${report.agentUsage.billing}`,
                report.agentUsage.billing === 'chatgpt-subscription'
                  ? `Agent usage: ${report.agentUsage.totals.tokens} conservatively counted tokens; USD unpriced / not applicable to subscription quota accounting (not $0 API usage)`
                  : `Agent usage: ${report.agentUsage.totals.tokens} conservatively counted tokens; $${report.agentUsage.totals.estimatedUsd!.toFixed(4)} accounted/catalog-estimated; $${report.agentUsage.totals.reportedUsd!.toFixed(4)} server-reported (not an invoice)`,
                ...report.agentUsage.sessions.map(
                  (session) =>
                    `Model: ${session.role} / ${session.id}: ${session.model.providerID}/${session.model.modelID}${session.model.variant ? `#${session.model.variant}` : ''}`,
                ),
                ...report.agentUsage.calls.map((call) => {
                  const dollars = call.status === 'completed' ? call.accountedUsd : call.reservedUsd
                  return `Call: attempt ${call.attempt} ${call.role}: ${call.status}; ${call.status === 'completed' ? call.accountedTokens : call.reservedTokens} tokens; ${dollars === null || dollars === undefined ? 'USD unpriced (subscription)' : `$${dollars.toFixed(4)}`}`
                }),
              ]
            : []),
          `Contract: ${report.contract.reference} (${report.contract.sha256})`,
          `Final candidate: ${report.finalCandidate?.path ?? '(none)'}`,
          `SHA-256: ${report.finalCandidate?.sha256 ?? '(none)'}`,
          '',
          ...report.attempts.flatMap((attempt) => [
            `## Attempt ${attempt.number}: ${attempt.outcome ?? 'in progress'}`,
            `Candidate: ${attempt.candidate?.sha256 ?? '(not built)'}`,
            `Implementation session: ${attempt.implementationSession ?? '(verify-only; none)'}`,
            `Checks: ${attempt.commands.map((command) => `${command.name}=${command.termination ?? command.signal ?? command.code}`).join(', ') || '(none)'}`,
            ...attempt.reviews.flatMap((review) => [
              `${review.role}: ${review.result?.decision ?? '(incomplete)'}; session ${review.session}`,
              ...(review.result?.findings ?? []).map((finding) => `    ${JSON.stringify(finding)}`),
            ]),
            `Acceptance verifier: ${attempt.verifier?.decision ?? '(not completed)'}; session ${attempt.verifierSession ?? '(none)'}`,
            ...(attempt.verifier?.findings ?? []).map(
              (finding) => `    ${JSON.stringify(finding)}`,
            ),
            ...(attempt.repairRationale
              ? [`Repair rationale: ${JSON.stringify(attempt.repairRationale)}`]
              : []),
            `Evidence: ${attempt.evidence}`,
            '',
          ]),
          ...report.cleanupErrors.map((error) => `Cleanup error: ${error}`),
          '',
          report.approval,
          '',
        ].join('\n'),
      )
    },
    async cleanup() {
      const errors = await agents.cleanup()
      if (lockOwned && !errors.length && !cleanupErrors.length) {
        try {
          await unlink(lock)
        } catch (error) {
          errors.push(String(error))
        }
      }
      return [...errors, ...cleanupErrors]
    },
  }
}
