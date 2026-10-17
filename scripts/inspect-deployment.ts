import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const positive = z.number().int().positive().safe()
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
const status = z.enum([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'neutral',
  'action_required',
  'stale',
  'startup_failure',
])
const runSchema = z.object({
  id: positive,
  run_attempt: positive,
  workflow_id: positive,
  head_sha: sha,
  path: z.string(),
  repository: z.object({ full_name: repository }),
  status: z.enum(['queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed']),
  conclusion: status.nullable(),
})
const jobSchema = z.object({
  id: positive,
  run_id: positive,
  run_attempt: positive,
  name: z.string(),
  status: z.enum(['queued', 'waiting', 'pending', 'in_progress', 'completed']),
  conclusion: status.nullable(),
  steps: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['queued', 'pending', 'in_progress', 'completed']),
        conclusion: status.nullable(),
      }),
    )
    .default([]),
})
const optionsSchema = z
  .object({
    repo: repository,
    workflow: z.string().regex(/^(?:[1-9]\d*|\.github\/workflows\/deploy\.yml)$/),
    commit: sha,
    run: positive.optional(),
    attempt: positive.optional(),
    discoverySeconds: positive.max(3600).default(60),
    waitSeconds: positive.max(7200).default(900),
    pollSeconds: positive.max(60).default(5),
  })
  .refine((value) => !value.attempt || value.run, 'An attempt requires an explicit run')
type Options = z.infer<typeof optionsSchema>
type Run = z.infer<typeof runSchema>
type Dependencies = {
  read: (endpoint: string, timeoutMs: number) => Promise<Buffer>
  archive: (data: Buffer, directory: string, files: string[]) => Record<string, unknown>
  now: () => number
  wait: (ms: number) => Promise<unknown>
}
export const requiredSteps = {
  plan: 'Save and inspect plan, then build matching web artifact',
  apply: 'Apply exact saved plan automatically (never replan)',
  terraform_outputs: 'Read production Terraform outputs',
  database_ready: 'Wait for database auto-resume',
  migrations: 'Run database migrations',
  lambda: 'Deploy API Lambda code',
  web: 'Deploy web artifact to S3',
  cloudfront: 'Invalidate CloudFront',
  health: 'Smoke test API Lambda',
  recipes: 'Smoke test DB-backed API through Cloudflare and Lambda',
  infrastructure: 'Verify production infrastructure and edge behavior',
} as const
const requiredJobs = [
  'Non-E2E Checks',
  'Plan And Deploy Infrastructure And App Artifacts',
  'Durable Run Result',
]
const infrastructureChecks = [
  'cloudfront-ready',
  'web-https-access',
  'api-https-access',
  'api-gateway-default-endpoint-disabled',
  'lambda-exact-code',
] as const
const reportSchema = z.object({
  schemaVersion: z.literal(1),
  repository,
  runId: z.string(),
  runAttempt: z.string(),
  commit: sha,
  success: z.boolean(),
  checks: z.array(z.object({ name: z.string(), status })),
  evidence: z.array(z.string()),
})
type Outcome = { name: string; status: string }
export type Inspection = {
  schemaVersion: 1
  selection: Options
  outcome: 'success' | 'failed' | 'incomplete' | 'timeout' | 'error'
  state: 'discovering' | 'queued' | 'approval-waiting' | 'running' | 'terminal'
  run: {
    id: number
    attempt: number
    latestAttempt: number
    url: string
    workflowId: number
    workflow: string
    commit: string
    conclusion: string | null
  } | null
  candidates: { id: number; attempt: number }[]
  jobs: Outcome[]
  checks: Outcome[]
  evidence: { name: string; status: 'validated' | 'unavailable' | 'restricted'; path?: string }[]
  plan: 'no-change' | 'changes' | 'unavailable'
  problems: string[]
  directory: string
}
class InspectionError extends Error {}
export class GitHubNotFound extends Error {}

// Never extract archive paths or retain raw ZIPs/Markdown. Persist schema-projected JSON only.
export function readEvidenceArchive(data: Buffer, directory: string, files: string[]) {
  const path = resolve(directory, 'download.private.zip')
  writeFileSync(path, data, { mode: 0o600 })
  const unzip = (args: string[]) =>
    execFileSync('unzip', args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  try {
    const entries = unzip(['-Z1', path]).trim().split('\n')
    const allowed = new Set([
      ...files,
      ...files.map((name) => name.replace(/\.json$/, '.md')),
      'prerequisite-failure.json',
    ])
    if (new Set(entries).size !== entries.length || entries.some((name) => !allowed.has(name)))
      throw new InspectionError('Unexpected artifact archive members')
    return Object.fromEntries(
      files.map((name) => {
        if (!entries.includes(name)) throw new InspectionError('Required artifact file missing')
        return [name, JSON.parse(unzip(['-p', path, name])) as unknown]
      }),
    )
  } finally {
    rmSync(path, { force: true })
  }
}

export async function inspectDeployment(
  input: unknown,
  dependencies: Dependencies,
): Promise<Inspection> {
  const options = optionsSchema.parse(input)
  process.umask(0o077)
  const base = resolve('.local/deployment-inspections', options.repo, options.commit)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const result: Inspection = {
    schemaVersion: 1,
    selection: options,
    outcome: 'incomplete',
    state: 'discovering',
    run: null,
    candidates: [],
    jobs: [],
    checks: [],
    evidence: [],
    plan: 'unavailable',
    problems: [],
    directory: mkdtempSync(resolve(base, 'discovery-')),
  }
  let deadline = dependencies.now() + options.discoverySeconds * 1000
  const read = async (endpoint: string) => {
    const remaining = deadline - dependencies.now()
    if (remaining <= 0) throw new InspectionError('Inspection phase deadline exceeded')
    return dependencies.read(endpoint, Math.min(30_000, remaining))
  }
  const json = async (endpoint: string): Promise<unknown> =>
    JSON.parse((await read(endpoint)).toString('utf8'))
  const root = `repos/${options.repo}/actions`
  const pause = async () => {
    const remaining = deadline - dependencies.now()
    if (remaining <= 0) return false
    await dependencies.wait(Math.min(options.pollSeconds * 1000, remaining))
    return dependencies.now() < deadline
  }
  const pages = async <T>(endpoint: string, key: string, schema: z.ZodType<T>) => {
    const values: T[] = []
    for (let page = 1; page <= 100; page++) {
      const data = z
        .object({ total_count: z.number().int().nonnegative() })
        .catchall(z.unknown())
        .parse(
          await json(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`),
        )
      const batch = z.array(schema).parse(data[key])
      values.push(...batch)
      if (values.length >= data.total_count) return values
      if (!batch.length) break
    }
    throw new InspectionError('GitHub pagination incomplete or collection exceeds limit')
  }
  const save = (name: string, data: unknown) =>
    writeFileSync(resolve(result.directory, name), JSON.stringify(data, null, 2) + '\n', {
      mode: 0o600,
    })
  let selected: Run | undefined
  try {
    const workflow = z
      .object({ id: positive, path: z.literal('.github/workflows/deploy.yml') })
      .parse(
        await json(
          `${root}/workflows/${encodeURIComponent(options.workflow === '.github/workflows/deploy.yml' ? 'deploy.yml' : options.workflow)}`,
        ),
      )
    const association = (run: Run) => {
      if (
        run.repository.full_name.toLowerCase() !== options.repo.toLowerCase() ||
        run.workflow_id !== workflow.id ||
        run.path !== workflow.path ||
        run.head_sha !== options.commit ||
        (options.run && run.id !== options.run)
      )
        throw new InspectionError(
          'Run does not match the exact repository, workflow, commit or run ID',
        )
      return run
    }
    do {
      if (options.run) {
        try {
          selected = association(runSchema.parse(await json(`${root}/runs/${options.run}`)))
        } catch (error) {
          if (!(error instanceof GitHubNotFound)) throw error
        }
      } else {
        const runs = await pages(
          `${root}/workflows/${workflow.id}/runs?head_sha=${options.commit}`,
          'workflow_runs',
          runSchema,
        )
        const matches = runs.filter(
          (run) => run.head_sha === options.commit && run.workflow_id === workflow.id,
        )
        result.candidates = matches.map((run) => ({ id: run.id, attempt: run.run_attempt }))
        if (matches.length > 1)
          throw new InspectionError('Multiple matching runs; select an explicit run ID')
        if (matches.length === 1) selected = association(matches[0]!)
      }
      if (selected) break
    } while (await pause())
    if (!selected) {
      result.outcome = 'timeout'
      result.problems.push('No matching run registered before discovery timeout')
    } else {
      const attempt = options.attempt ?? selected.run_attempt
      result.run = {
        id: selected.id,
        attempt,
        latestAttempt: selected.run_attempt,
        workflowId: workflow.id,
        workflow: workflow.path,
        commit: selected.head_sha,
        conclusion: selected.conclusion,
        url: `https://github.com/${options.repo}/actions/runs/${selected.id}/attempts/${attempt}`,
      }
      const runDirectory = resolve(base, `run-${selected.id}-attempt-${attempt}`)
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
      rmSync(result.directory, { recursive: true }) // Empty directory created by this invocation only.
      result.directory = mkdtempSync(resolve(runDirectory, 'inspection-'))
      if (!options.attempt && selected.run_attempt > 1)
        throw new InspectionError(
          'Rerun has multiple attempts; select --run and --attempt explicitly',
        )
      if (attempt > selected.run_attempt)
        throw new InspectionError('Requested attempt is not registered')
      deadline = dependencies.now() + options.waitSeconds * 1000
      do {
        const latest = association(runSchema.parse(await json(`${root}/runs/${selected.id}`)))
        result.run.latestAttempt = latest.run_attempt
        if (!options.attempt && latest.run_attempt !== attempt)
          throw new InspectionError(
            'Run attempt changed while inspecting; select an explicit attempt',
          )
        const current = association(
          runSchema.parse(await json(`${root}/runs/${selected.id}/attempts/${attempt}`)),
        )
        if (current.run_attempt !== attempt) throw new InspectionError('Attempt response mismatch')
        result.run.conclusion = current.conclusion
        if (current.status === 'completed') {
          result.state = 'terminal'
          break
        }
        const pending = z
          .array(z.object({ environment: z.object({ id: positive }) }))
          .parse(await json(`${root}/runs/${selected.id}/pending_deployments`))
        result.state =
          pending.length || current.status === 'waiting'
            ? 'approval-waiting'
            : current.status === 'in_progress'
              ? 'running'
              : 'queued'
      } while (await pause())
      const timedOut = result.state !== 'terminal'
      if (timedOut)
        result.problems.push(
          `Completion timeout while ${result.state}; no approval or rerun was requested`,
        )
      deadline = dependencies.now() + 120_000
      const jobs = await pages(
        `${root}/runs/${selected.id}/attempts/${attempt}/jobs`,
        'jobs',
        jobSchema,
      )
      if (jobs.some((job) => job.run_id !== selected!.id || job.run_attempt !== attempt))
        throw new InspectionError('Job run/attempt provenance mismatch')
      const outcome = (
        name: string,
        matches: { status: string; conclusion: string | null }[],
        target: Outcome[],
      ) => {
        const value =
          matches.length === 1
            ? matches[0]!.status === 'completed'
              ? (matches[0]!.conclusion ?? 'missing-conclusion')
              : matches[0]!.status
            : matches.length
              ? 'duplicate'
              : 'missing'
        target.push({ name, status: value })
        if (value !== 'success') result.problems.push(`${name}: ${value}`)
      }
      for (const name of requiredJobs)
        outcome(
          name,
          jobs.filter((job) => job.name === name),
          result.jobs,
        )
      const deployment = jobs.filter((job) => job.name === requiredJobs[1])
      for (const [key, name] of Object.entries(requiredSteps))
        outcome(
          key,
          deployment.flatMap((job) => job.steps.filter((step) => step.name === name)),
          result.checks,
        )
      for (const name of [
        'Initialize and confirm deployment target',
        'Build API artifact',
        'Durable deployment verification contract',
        'Retain safe deployment evidence',
      ])
        outcome(
          name,
          deployment.flatMap((job) => job.steps.filter((step) => step.name === name)),
          result.checks,
        )
      for (const [jobName, names] of [
        [
          requiredJobs[0]!,
          [
            'Lint',
            'Check deployment command formatting',
            'Typecheck',
            'Check database migrations',
            'Unit tests',
            'Build',
          ],
        ],
        [
          requiredJobs[2]!,
          [
            'Record every stage including failed or skipped deployment',
            'Retain durable run result',
          ],
        ],
      ] as const)
        for (const name of names)
          outcome(
            name,
            jobs
              .filter((job) => job.name === jobName)
              .flatMap((job) => job.steps.filter((step) => step.name === name)),
            result.checks,
          )
      const artifactSchema = z.object({
        id: positive,
        name: z.string(),
        expired: z.boolean(),
        size_in_bytes: positive,
      })
      let artifacts: z.infer<typeof artifactSchema>[] = []
      try {
        artifacts = await pages(
          `${root}/runs/${selected.id}/artifacts`,
          'artifacts',
          artifactSchema,
        )
      } catch {
        result.problems.push(
          'Artifact listing unavailable or invalid; required evidence cannot be verified',
        )
      }
      const artifact = async (
        prefix: string,
        files: string[],
        validate: (data: Record<string, unknown>) => unknown,
      ) => {
        const name = `${prefix}-${selected!.id}-${attempt}`
        let reason = 'invalid report or archive'
        try {
          const matching = artifacts.filter((item) => item.name === name)
          if (matching.length !== 1) {
            reason = matching.length ? 'duplicate artifact' : 'missing artifact'
            throw new InspectionError(reason)
          }
          if (matching[0]!.expired || matching[0]!.size_in_bytes > 4 * 1024 * 1024) {
            reason = matching[0]!.expired ? 'expired artifact' : 'oversized artifact'
            throw new InspectionError(reason)
          }
          reason = 'artifact download failed'
          const data = await read(`${root}/artifacts/${matching[0]!.id}/zip`)
          reason = 'invalid report or archive'
          const safe = validate(dependencies.archive(data, result.directory, files))
          reason = 'local evidence write failed'
          save(`${prefix}.json`, safe)
          result.evidence.push({ name, status: 'validated', path: `${prefix}.json` })
        } catch {
          result.evidence.push({ name, status: 'unavailable' })
          result.problems.push(`${name}: ${reason} (payload omitted)`)
        }
      }
      const report = (input: unknown, names: string[]) => {
        const parsed = reportSchema.parse(input)
        if (
          parsed.repository.toLowerCase() !== options.repo.toLowerCase() ||
          parsed.runId !== String(selected!.id) ||
          parsed.runAttempt !== String(attempt) ||
          parsed.commit !== options.commit ||
          parsed.checks.length !== names.length ||
          names.some((name) => parsed.checks.filter((check) => check.name === name).length !== 1) ||
          parsed.success !== parsed.checks.every((check) => check.status === 'success')
        )
          throw new InspectionError('Report provenance or required checks invalid')
        for (const check of parsed.checks.filter((check) => check.status !== 'success'))
          result.problems.push(`Evidence check ${check.name}: ${check.status}`)
        return { ...parsed, evidence: [] } // Do not propagate arbitrary downloaded labels.
      }
      let planHash: string | undefined
      await artifact('plan-report', ['policy.json', 'manifest.json'], (data) => {
        const policy = z
          .object({
            schemaVersion: z.literal(1),
            authority: z.literal('actions-saved-plan'),
            policyPassed: z.literal(true),
            resources: z.array(
              z.object({
                actions: z
                  .array(
                    z.enum([
                      'no-op',
                      'read',
                      'create',
                      'update',
                      'delete',
                      'forget',
                      'create-forget',
                    ]),
                  )
                  .min(1),
              }),
            ),
            findings: z.array(z.object({ severity: z.enum(['review', 'unresolved']) })),
          })
          .parse(data['policy.json'])
        const manifest = z
          .object({
            schemaVersion: z.literal(1),
            identity: z.object({
              repository,
              runId: z.string(),
              runAttempt: z.string(),
              commit: sha,
            }),
            files: z.record(z.string(), digest),
          })
          .parse(data['manifest.json'])
        const identity = manifest.identity
        if (
          identity.repository.toLowerCase() !== options.repo.toLowerCase() ||
          identity.runId !== String(selected!.id) ||
          identity.runAttempt !== String(attempt) ||
          identity.commit !== options.commit
        )
          throw new InspectionError('Plan provenance mismatch')
        planHash = digest.parse(manifest.files['.local/deploy/plan.tfplan'])
        result.plan = policy.resources.every((resource) =>
          resource.actions.every((action) => ['no-op', 'read'].includes(action)),
        )
          ? 'no-change'
          : 'changes'
        result.checks.push({ name: 'authoritative-policy', status: 'success' })
        return {
          schemaVersion: 1,
          identity,
          planSha256: planHash,
          policyPassed: true,
          plan: result.plan,
          reviewFindings: policy.findings.length,
        }
      })
      await artifact(
        'deployment-verification',
        ['verification.json', 'infrastructure-verification.json'],
        (data) => {
          const verification = report(data['verification.json'], Object.keys(requiredSteps))
          const hash = z.object({ planSha256: digest }).parse(data['verification.json']).planSha256
          if (!planHash || hash !== planHash)
            throw new InspectionError('Saved plan hash mismatch or unavailable')
          const infrastructure = z
            .object({
              schemaVersion: z.literal(1),
              success: z.boolean(),
              checks: z.array(
                z.object({
                  name: z.enum(infrastructureChecks),
                  status: z.enum(['passed', 'failed']),
                  attempts: positive.max(3),
                }),
              ),
            })
            .parse(data['infrastructure-verification.json'])
          if (
            infrastructure.checks.length !== infrastructureChecks.length ||
            infrastructureChecks.some(
              (name) => infrastructure.checks.filter((check) => check.name === name).length !== 1,
            ) ||
            infrastructure.success !==
              infrastructure.checks.every((check) => check.status === 'passed')
          )
            throw new InspectionError('Missing or inconsistent infrastructure check')
          for (const check of infrastructure.checks.filter((check) => check.status !== 'passed'))
            result.problems.push(`Infrastructure check ${check.name}: ${check.status}`)
          result.checks.push(
            ...infrastructure.checks.map((check) => ({ name: check.name, status: check.status })),
          )
          return { verification, planSha256: hash, infrastructure }
        },
      )
      await artifact('deployment-result', ['run-result.json'], (data) =>
        report(data['run-result.json'], ['checks', 'deploy']),
      )
      for (const job of jobs.filter(
        (job) =>
          (job.conclusion && !['success', 'skipped', 'neutral'].includes(job.conclusion)) ||
          job.steps.some(
            (step) =>
              step.conclusion && !['success', 'skipped', 'neutral'].includes(step.conclusion),
          ),
      )) {
        const name = `job-${job.id}-restricted.log`
        try {
          const log = await read(`${root}/jobs/${job.id}/logs`)
          if (!log.length) throw new InspectionError('Empty job log')
          writeFileSync(resolve(result.directory, name), log, { mode: 0o600 })
          result.evidence.push({ name: `job-${job.id}`, status: 'restricted', path: name })
        } catch {
          result.evidence.push({ name: `job-${job.id}`, status: 'unavailable' })
          result.problems.push(`job-${job.id}: restricted diagnostics unavailable`)
        }
      }
      const final = association(runSchema.parse(await json(`${root}/runs/${selected.id}`)))
      result.run.latestAttempt = final.run_attempt
      if (!options.attempt && final.run_attempt !== attempt)
        throw new InspectionError('Run attempt changed during evidence collection')
      result.outcome = timedOut
        ? 'timeout'
        : result.run.conclusion !== 'success'
          ? 'failed'
          : result.problems.length
            ? 'incomplete'
            : 'success'
    }
  } catch (error) {
    result.outcome = 'error'
    result.problems.push(
      error instanceof InspectionError
        ? error.message
        : 'GitHub request, prerequisite or schema validation failed (sensitive diagnostics omitted)',
    )
  }
  save('result.json', result)
  writeFileSync(resolve(result.directory, 'summary.md'), renderInspection(result), { mode: 0o600 })
  return result
}

export function renderInspection(result: Inspection) {
  return [
    `# Deployment inspection: ${result.outcome.toUpperCase()}`,
    `Repository: ${result.selection.repo}`,
    `Workflow: ${result.run?.workflow ?? result.selection.workflow}`,
    `Commit: ${result.selection.commit}`,
    result.run
      ? `Run: ${result.run.id}, attempt ${result.run.attempt} (latest observed: ${result.run.latestAttempt})\n${result.run.url}\nConclusion: ${result.run.conclusion ?? 'pending'}`
      : 'Run: not selected',
    `State: ${result.state}`,
    `Terraform resource plan: ${result.plan} (apply and verification still required)`,
    ...result.jobs.map((check) => `- Job ${check.name}: ${check.status}`),
    ...result.checks.map((check) => `- Check ${check.name}: ${check.status}`),
    ...result.evidence.map((item) => `- Evidence ${item.name}: ${item.status}`),
    ...result.problems.map((problem) => `- ${problem}`),
    `Reports: ${result.directory}`,
    'Restricted logs are not sanitized reports; do not share them with agents.',
    '',
  ].join('\n')
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      workflow: { type: 'string' },
      commit: { type: 'string' },
      run: { type: 'string' },
      attempt: { type: 'string' },
      'discovery-seconds': { type: 'string' },
      'wait-seconds': { type: 'string' },
      'poll-seconds': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const number = (value: string | undefined) => (value === undefined ? undefined : Number(value))
  const result = await inspectDeployment(
    {
      repo: values.repo,
      workflow: values.workflow,
      commit: values.commit,
      run: number(values.run),
      attempt: number(values.attempt),
      discoverySeconds: number(values['discovery-seconds']),
      waitSeconds: number(values['wait-seconds']),
      pollSeconds: number(values['poll-seconds']),
    },
    {
      // No shell, arbitrary commands, GitHub writes, credentials or production HTTP calls.
      read: async (endpoint, timeout) => {
        try {
          return execFileSync(
            'gh',
            ['api', '--hostname', 'github.com', '--method', 'GET', endpoint],
            {
              timeout,
              maxBuffer: 16 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
            },
          )
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'stderr' in error &&
            /\(HTTP 404\)/.test(String(error.stderr))
          )
            throw new GitHubNotFound()
          throw new InspectionError(
            'GitHub GET failed or exceeded its request deadline (diagnostics omitted)',
          )
        }
      },
      archive: readEvidenceArchive,
      now: () => performance.now(),
      wait: setTimeout,
    },
  )
  console.log(values.json ? JSON.stringify(result, null, 2) : renderInspection(result))
  process.exitCode = result.outcome === 'success' ? 0 : result.outcome === 'error' ? 2 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      'Inspection setup failed: check arguments, Node/gh/unzip prerequisites and local evidence permissions. Sensitive diagnostics omitted.',
    )
    process.exitCode = 2
  })
