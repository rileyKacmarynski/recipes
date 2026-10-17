import assert from 'node:assert/strict'
import { after, test, type TestContext } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  GitHubNotFound,
  inspectDeployment,
  readEvidenceArchive,
  requiredSteps,
} from './inspect-deployment.ts'

// Run evidence-producing tests in disposable scratch, including inside isolated loop checks.
const project = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'recipes-monitor-tests-'))
process.chdir(scratch)
after(() => {
  process.chdir(project)
  rmSync(scratch, { recursive: true, force: true })
})

const commit = 'a'.repeat(40)
const planHash = 'b'.repeat(64)
const options = {
  repo: 'fixture/recipes',
  workflow: '.github/workflows/deploy.yml',
  commit,
  discoverySeconds: 2,
  waitSeconds: 2,
  pollSeconds: 1,
}
const identity = { repository: options.repo, runId: '123', runAttempt: '1', commit }
const root = `repos/${options.repo}/actions`
const list = (key: string, values: unknown[], total = values.length) => ({
  total_count: total,
  [key]: values,
})
const report = (names: string[]) => ({
  schemaVersion: 1,
  ...identity,
  success: true,
  checks: names.map((name) => ({ name, status: 'success' })),
  evidence: ['UNTRUSTED_TOKEN'],
})
const step = (name: string) => ({ name, status: 'completed', conclusion: 'success' })
function fixture() {
  const run = {
    id: 123,
    run_attempt: 1,
    workflow_id: 42,
    head_sha: commit,
    path: options.workflow,
    repository: { full_name: options.repo },
    status: 'completed',
    conclusion: 'success',
  }
  const jobs = [
    'Non-E2E Checks',
    'Plan And Deploy Infrastructure And App Artifacts',
    'Durable Run Result',
  ].map((name, index) => ({
    id: index + 1,
    run_id: 123,
    run_attempt: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    steps:
      index === 1
        ? [
            ...Object.values(requiredSteps),
            'Initialize and confirm deployment target',
            'Build API artifact',
            'Durable deployment verification contract',
            'Retain safe deployment evidence',
          ].map(step)
        : index === 0
          ? [
              'Lint',
              'Check deployment command formatting',
              'Typecheck',
              'Check database migrations',
              'Unit tests',
              'Build',
            ].map(step)
          : [
              'Record every stage including failed or skipped deployment',
              'Retain durable run result',
            ].map(step),
  }))
  const archives: Record<string, Record<string, unknown>> = {
    '1': {
      'policy.json': {
        schemaVersion: 1,
        authority: 'actions-saved-plan',
        policyPassed: true,
        resources: [],
        findings: [],
        raw_secret: 'UNTRUSTED_TOKEN',
      },
      'manifest.json': {
        schemaVersion: 1,
        identity,
        files: { '.local/deploy/plan.tfplan': planHash },
      },
    },
    '2': {
      'verification.json': { ...report(Object.keys(requiredSteps)), planSha256: planHash },
      'infrastructure-verification.json': {
        schemaVersion: 1,
        success: true,
        checks: [
          'cloudfront-ready',
          'web-https-access',
          'api-https-access',
          'api-gateway-default-endpoint-disabled',
          'lambda-exact-code',
        ].map((name) => ({ name, status: 'passed', attempts: 1, detail: 'UNTRUSTED_TOKEN' })),
      },
    },
    '3': { 'run-result.json': report(['checks', 'deploy']) },
  }
  const artifacts = ['plan-report', 'deployment-verification', 'deployment-result'].map(
    (name, index) => ({
      id: index + 1,
      name: `${name}-123-1`,
      expired: false,
      size_in_bytes: 1000,
    }),
  )
  return { run, jobs, archives, artifacts }
}
type Fixture = ReturnType<typeof fixture>
type Handler = (endpoint: string, fixture: Fixture) => unknown
async function inspect(
  t: TestContext,
  changes?: (fixture: Fixture) => void,
  handler?: Handler,
  overrides = {},
) {
  const f = fixture()
  changes?.(f)
  let now = 0
  const requests: string[] = []
  const read = async (endpoint: string, timeout: number) => {
    assert.ok(timeout > 0 && timeout <= 30_000)
    requests.push(endpoint)
    const custom = handler?.(endpoint, f)
    if (custom !== undefined) return Buffer.from(JSON.stringify(custom))
    let value: unknown
    if (endpoint === `${root}/workflows/deploy.yml` || endpoint === `${root}/workflows/42`)
      value = { id: 42, path: options.workflow }
    else if (endpoint.startsWith(`${root}/workflows/42/runs?`))
      value = list('workflow_runs', [f.run])
    else if (endpoint === `${root}/runs/123` || /\/runs\/123\/attempts\/\d+$/.test(endpoint))
      value = f.run
    else if (endpoint.includes('/jobs?')) value = list('jobs', f.jobs)
    else if (endpoint.includes('/artifacts?')) value = list('artifacts', f.artifacts)
    else if (endpoint.endsWith('/pending_deployments')) value = []
    else if (/\/artifacts\/\d+\/zip$/.test(endpoint))
      value = f.archives[endpoint.split('/').at(-2)!]
    else if (/\/jobs\/\d+\/logs$/.test(endpoint)) return Buffer.from('RESTRICTED_SECRET_DIAGNOSTIC')
    else throw new Error(`Unexpected request ${endpoint}`)
    return Buffer.from(JSON.stringify(value))
  }
  const result = await inspectDeployment(
    { ...options, ...overrides },
    {
      read,
      archive: (data) => JSON.parse(data.toString('utf8')) as Record<string, unknown>,
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
    },
  )
  t.after(() => rmSync(result.directory, { recursive: true, force: true }))
  assert.deepEqual(JSON.parse(readFileSync(join(result.directory, 'result.json'), 'utf8')), result)
  return { result, requests, now, fixture: f }
}

test('exact commit/workflow success retains only safe reports, with no-change apply and both smoke checks', async (t) => {
  const { result, requests } = await inspect(t)
  assert.equal(result.outcome, 'success')
  assert.equal(result.plan, 'no-change')
  assert.equal(result.run?.attempt, 1)
  assert.ok(requests.some((path) => path.includes(`head_sha=${commit}`)))
  assert.equal(
    requests.some((path) => path.endsWith('/logs')),
    false,
  )
  assert.equal(result.evidence.filter((item) => item.status === 'validated').length, 3)
  for (const name of readdirSync(result.directory)) {
    const text = readFileSync(join(result.directory, name), 'utf8')
    assert.ok(!text.includes('UNTRUSTED_TOKEN'))
    assert.equal(statSync(join(result.directory, name)).mode & 0o777, 0o600)
  }
  assert.equal(statSync(result.directory).mode & 0o777, 0o700)
  assert.equal(result.checks.find((check) => check.name === 'recipes')?.status, 'success')
})

test('inspection contract matches the checked-in deployment workflow, including both production smoke tests', () => {
  const workflow = readFileSync(resolve(project, '.github/workflows/deploy.yml'), 'utf8')
  for (const name of Object.values(requiredSteps)) assert.ok(workflow.includes(`- name: ${name}\n`))
  const contract = workflow.match(/const required = (\[[^\n]+\]);/)?.[1]
  assert.ok(contract)
  assert.deepEqual(JSON.parse(contract.replaceAll("'", '"')), [
    'plan',
    'apply',
    'terraform_outputs',
    'database_ready',
    'migrations',
    'lambda',
    'web',
    'cloudfront',
    'health',
    'recipes',
    'infrastructure',
  ])
})

test('waits for discovery, then queued, approval-waiting and running before completion', async (t) => {
  let discovery = 0,
    polls = 0
  const { result, now } = await inspect(
    t,
    undefined,
    (endpoint, f) => {
      if (endpoint.includes('/workflows/42/runs?'))
        return list('workflow_runs', ++discovery === 1 ? [] : [f.run])
      if (endpoint === `${root}/runs/123/attempts/1`) {
        const state = ['queued', 'waiting', 'in_progress', 'completed'][polls++]!
        return { ...f.run, status: state, conclusion: state === 'completed' ? 'success' : null }
      }
    },
    { waitSeconds: 5 },
  )
  assert.equal(result.outcome, 'success')
  assert.equal(now, 4000)
})

test('explicit unregistered run gets bounded discovery, not an unqualified latest fallback', async (t) => {
  let queries = 0
  const found = await inspect(
    t,
    undefined,
    (endpoint, f) => {
      if (endpoint === `${root}/runs/123` && queries++ === 0) throw new GitHubNotFound()
      if (endpoint === `${root}/runs/123`) return f.run
    },
    { run: 123 },
  )
  assert.equal(found.result.outcome, 'success')
  assert.equal(found.now, 1000)
  const missing = await inspect(
    t,
    undefined,
    (endpoint) => {
      if (endpoint === `${root}/runs/123`) throw new GitHubNotFound()
    },
    { run: 123 },
  )
  assert.equal(missing.result.outcome, 'timeout')
  assert.equal(missing.now, 2000)
  assert.equal(
    missing.requests.some((path) => path.includes('/workflows/42/runs?')),
    false,
  )
})

test('no runs times out and multiple matches fail, including a match on a later page', async (t) => {
  const missing = await inspect(t, undefined, (endpoint) =>
    endpoint.includes('/workflows/42/runs?') ? list('workflow_runs', []) : undefined,
  )
  assert.equal(missing.result.outcome, 'timeout')
  assert.equal(missing.now, 2000)
  const ambiguous = await inspect(t, undefined, (endpoint, f) => {
    if (endpoint.includes('/workflows/42/runs?'))
      return list('workflow_runs', [{ ...f.run, id: endpoint.endsWith('page=1') ? 123 : 124 }], 2)
  })
  assert.equal(ambiguous.result.outcome, 'error')
  assert.equal(ambiguous.result.candidates.length, 2)
  assert.match(ambiguous.result.problems.join(), /Multiple matching/)
})

test('explicit run must match repository, workflow path, workflow ID and exact commit', async (t) => {
  for (const field of [
    { repository: { full_name: 'other/repo' } },
    { path: '.github/workflows/ci.yml' },
    { workflow_id: 43 },
    { head_sha: 'c'.repeat(40) },
    { id: 124 },
  ]) {
    const { result } = await inspect(t, (f) => Object.assign(f.run, field), undefined, { run: 123 })
    assert.equal(result.outcome, 'error')
    assert.match(result.problems.join(), /does not match/)
  }
})

test('reruns require explicit run/attempt; an explicit historical attempt is labeled, not replaced', async (t) => {
  const rerun = await inspect(t, (f) => {
    f.run.run_attempt = 2
  })
  assert.equal(rerun.result.outcome, 'error')
  assert.match(rerun.result.problems.join(), /select --run and --attempt/)
  const historical = await inspect(
    t,
    (f) => {
      f.run.run_attempt = 2
    },
    (endpoint, f) => (endpoint.endsWith('/attempts/1') ? { ...f.run, run_attempt: 1 } : undefined),
    { run: 123, attempt: 1 },
  )
  assert.equal(historical.result.outcome, 'success')
  assert.equal(historical.result.run?.latestAttempt, 2)
  assert.equal(historical.result.run?.attempt, 1)
  const future = await inspect(t, undefined, undefined, { run: 123, attempt: 2 })
  assert.equal(future.result.outcome, 'error')
})

test('attempt changes during waiting or evidence collection never certify success', async (t) => {
  for (const threshold of [2, 3]) {
    let reads = 0
    const { result } = await inspect(
      t,
      undefined,
      (endpoint, f) =>
        endpoint === `${root}/runs/123`
          ? { ...f.run, run_attempt: ++reads >= threshold ? 2 : 1 }
          : undefined,
      { run: 123 },
    )
    assert.equal(result.outcome, 'error')
    assert.match(result.problems.join(), /attempt changed/)
  }
  const wrong = await inspect(t, undefined, (endpoint, f) =>
    endpoint.endsWith('/attempts/1') ? { ...f.run, run_attempt: 2 } : undefined,
  )
  assert.equal(wrong.result.outcome, 'error')
})

test('queued, native approval and running timeouts stay incomplete without approving anything', async (t) => {
  for (const state of ['queued', 'in_progress', 'waiting']) {
    const { result, now } = await inspect(
      t,
      (f) => {
        f.run.status = state
        f.run.conclusion = null!
      },
      (endpoint) =>
        endpoint.endsWith('/pending_deployments') && state === 'waiting'
          ? [{ environment: { id: 1 } }]
          : undefined,
    )
    assert.equal(result.outcome, 'timeout')
    assert.equal(
      result.state,
      state === 'waiting' ? 'approval-waiting' : state === 'in_progress' ? 'running' : 'queued',
    )
    assert.equal(now, 2000)
  }
  const native = await inspect(
    t,
    (f) => {
      f.run.status = 'in_progress'
      f.run.conclusion = null!
    },
    (endpoint) =>
      endpoint.endsWith('/pending_deployments') ? [{ environment: { id: 1 } }] : undefined,
  )
  assert.equal(native.result.state, 'approval-waiting')
})

test('failure, cancellation and GitHub timeout collect only failed-job restricted logs', async (t) => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const { result, requests } = await inspect(t, (f) => {
      f.run.conclusion = conclusion
      f.jobs[1]!.conclusion = conclusion
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.run?.conclusion, conclusion)
    assert.equal(requests.filter((path) => path.endsWith('/logs')).length, 1)
    assert.equal(
      readFileSync(join(result.directory, 'job-2-restricted.log'), 'utf8'),
      'RESTRICTED_SECRET_DIAGNOSTIC',
    )
    assert.ok(
      !readFileSync(join(result.directory, 'summary.md'), 'utf8').includes(
        'RESTRICTED_SECRET_DIAGNOSTIC',
      ),
    )
  }
})

test('green run with skipped/missing/duplicate required steps or missing jobs is incomplete even for no-change plan', async (t) => {
  for (const modify of [
    (f: Fixture) => {
      f.jobs[1]!.steps.find((step) => step.name === requiredSteps.recipes)!.conclusion = 'skipped'
    },
    (f: Fixture) => {
      f.jobs[1]!.steps = f.jobs[1]!.steps.filter((step) => step.name !== requiredSteps.apply)
    },
    (f: Fixture) => {
      f.jobs[1]!.steps.push(step(requiredSteps.health))
    },
    (f: Fixture) => {
      f.jobs.pop()
    },
    (f: Fixture) => {
      f.jobs[1]!.steps[0]!.status = 'in_progress'
    },
  ]) {
    const { result } = await inspect(t, modify)
    assert.equal(result.outcome, 'incomplete')
    assert.ok(result.problems.length)
  }
})

test('missing, expired, duplicate, oversized and malformed evidence is explicit, never successful', async (t) => {
  for (const modify of [
    (f: Fixture) => {
      f.artifacts.pop()
    },
    (f: Fixture) => {
      f.artifacts[0]!.expired = true
    },
    (f: Fixture) => {
      f.artifacts.push(f.artifacts[0]!)
    },
    (f: Fixture) => {
      f.artifacts[0]!.size_in_bytes = 5 * 1024 * 1024
    },
    (f: Fixture) => {
      f.archives['2']!['verification.json'] = {}
    },
    (f: Fixture) => {
      f.artifacts[2]!.name = 'deployment-result-123-2'
    },
  ]) {
    const { result } = await inspect(t, modify)
    assert.equal(result.outcome, 'incomplete')
    assert.ok(result.evidence.some((item) => item.status === 'unavailable'))
  }
})

test('checks report provenance, exact check set and plan hashes rather than trusting success flags', async (t) => {
  for (const mutation of [
    { commit: 'c'.repeat(40) },
    { runId: '124' },
    { runAttempt: '2' },
    { repository: 'other/repo' },
    { planSha256: 'd'.repeat(64) },
    { checks: [] },
    { schemaVersion: 2 },
  ]) {
    const { result } = await inspect(t, (f) => {
      Object.assign(f.archives['2']!['verification.json'] as object, mutation)
    })
    assert.equal(result.outcome, 'incomplete')
  }
  const failed = await inspect(t, (f) => {
    const evidence = f.archives['2']!['verification.json'] as ReturnType<typeof report>
    evidence.success = false
    evidence.checks.find((check) => check.name === 'recipes')!.status = 'skipped'
  })
  assert.equal(failed.result.outcome, 'incomplete')
  assert.match(failed.result.problems.join(), /Evidence check recipes: skipped/)
})

test('unavailable logs, API errors and malformed GitHub responses omit sensitive diagnostics', async (t) => {
  const logs = await inspect(
    t,
    (f) => {
      f.run.conclusion = 'failure'
      f.jobs[1]!.conclusion = 'failure'
    },
    (endpoint) => {
      if (endpoint.endsWith('/logs')) throw new Error('SECRET_BACKEND_ERROR')
    },
  )
  assert.match(logs.result.problems.join(), /diagnostics unavailable/)
  const api = await inspect(t, undefined, (endpoint) => {
    if (endpoint.includes('/workflows/')) throw new Error('SECRET_BACKEND_ERROR')
  })
  assert.equal(api.result.outcome, 'error')
  assert.ok(!JSON.stringify(api.result).includes('SECRET_BACKEND_ERROR'))
  const malformed = await inspect(t, undefined, (endpoint) =>
    endpoint.includes('/workflows/') ? { id: '42' } : undefined,
  )
  assert.equal(malformed.result.outcome, 'error')
})

test('evidence download/listing failures are explicit and do not suppress failed-job logs', async (t) => {
  for (const unavailable of ['/artifacts?', '/artifacts/2/zip']) {
    const { result, requests } = await inspect(
      t,
      (f) => {
        f.run.conclusion = 'failure'
        f.jobs[1]!.conclusion = 'failure'
      },
      (endpoint) => {
        if (endpoint.includes(unavailable)) throw new Error('SECRET_ARTIFACT_ERROR')
      },
    )
    assert.equal(result.outcome, 'failed')
    assert.ok(result.evidence.some((item) => item.status === 'unavailable'))
    assert.ok(requests.some((path) => path.endsWith('/jobs/2/logs')))
    assert.ok(!JSON.stringify(result).includes('SECRET_ARTIFACT_ERROR'))
  }
})

test('valid failed infrastructure evidence is retained; missing checks and mismatched job attempts cannot pass', async (t) => {
  const failed = await inspect(t, (f) => {
    const infra = f.archives['2']!['infrastructure-verification.json'] as {
      success: boolean
      checks: { status: string }[]
    }
    infra.success = false
    infra.checks[0]!.status = 'failed'
  })
  assert.equal(failed.result.outcome, 'incomplete')
  assert.equal(
    failed.result.checks.find((check) => check.name === 'cloudfront-ready')?.status,
    'failed',
  )
  const missing = await inspect(t, (f) => {
    ;(f.archives['2']!['infrastructure-verification.json'] as { checks: unknown[] }).checks.pop()
  })
  assert.equal(missing.result.outcome, 'incomplete')
  const provenance = await inspect(t, (f) => {
    f.jobs[0]!.run_attempt = 2
  })
  assert.equal(provenance.result.outcome, 'error')
})

test('changed-resource plans still require all checks and repeated inspections preserve earlier reports', async (t) => {
  const first = await inspect(t, (f) => {
    ;(f.archives['1']!['policy.json'] as { resources: unknown[] }).resources.push({
      actions: ['update'],
    })
  })
  assert.equal(first.result.outcome, 'success')
  assert.equal(first.result.plan, 'changes')
  const before = readFileSync(join(first.result.directory, 'result.json'), 'utf8')
  const second = await inspect(t)
  assert.notEqual(first.result.directory, second.result.directory)
  assert.equal(readFileSync(join(first.result.directory, 'result.json'), 'utf8'), before)
})

test('inputs reject branch names, unsafe paths, missing identities and unbounded waits before accessing GitHub', async () => {
  for (const mutation of [
    { commit: 'main' },
    { repo: '../..' },
    { workflow: 'Deploy' },
    { repo: undefined },
    { waitSeconds: 7201 },
    { attempt: 1 },
  ]) {
    await assert.rejects(
      inspectDeployment(
        { ...options, ...mutation },
        {
          read: async () => {
            assert.fail('No GitHub calls allowed')
          },
          archive: () => ({}),
          now: Date.now,
          wait: async () => {},
        },
      ),
    )
  }
})

function archive(t: TestContext, files: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-monitor-archive-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(directory, name), JSON.stringify(value))
  const buffer = execFileSync('zip', ['-q', '-', ...Object.keys(files)], { cwd: directory })
  return { buffer, directory }
}

test('real archive reader accepts only designated members, rejects raw/private extras, and removes ZIPs', (t) => {
  const safe = archive(t, {
    'verification.json': { schemaVersion: 1 },
    'verification.md': 'NOT_SHARED',
  })
  assert.deepEqual(readEvidenceArchive(safe.buffer, safe.directory, ['verification.json']), {
    'verification.json': { schemaVersion: 1 },
  })
  assert.equal(existsSync(join(safe.directory, 'download.private.zip')), false)
  const unsafe = archive(t, {
    'verification.json': {},
    'outputs.private.json': { token: 'SECRET' },
  })
  assert.throws(() => readEvidenceArchive(unsafe.buffer, unsafe.directory, ['verification.json']))
  assert.equal(existsSync(join(unsafe.directory, 'download.private.zip')), false)
  assert.throws(() =>
    readEvidenceArchive(Buffer.from('INVALID_ZIP'), safe.directory, ['verification.json']),
  )
  assert.equal(existsSync(join(safe.directory, 'download.private.zip')), false)
})

test('CLI uses only gh GET, produces clean machine output and documented exit codes against a fake gh', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-monitor-gh-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const f = fixture()
  const routes: Record<string, unknown> = {
    [`${root}/workflows/deploy.yml`]: { id: 42, path: options.workflow },
    [`${root}/runs/123`]: f.run,
    [`${root}/runs/123/attempts/1`]: f.run,
    [`${root}/runs/123/attempts/1/jobs?per_page=100&page=1`]: list('jobs', f.jobs),
    [`${root}/runs/123/artifacts?per_page=100&page=1`]: list('artifacts', f.artifacts),
  }
  const encoded: Record<string, string> = Object.fromEntries(
    Object.entries(routes).map(([key, value]) => [
      key,
      Buffer.from(JSON.stringify(value)).toString('base64'),
    ]),
  )
  for (const [id, files] of Object.entries(f.archives))
    encoded[`${root}/artifacts/${id}/zip`] = archive(t, files).buffer.toString('base64')
  const installGh = () =>
    writeFileSync(
      join(directory, 'gh'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (JSON.stringify(args.slice(0, 6)) !== JSON.stringify(['api','--hostname','github.com','--method','GET',args[5]])) process.exit(99);
const routes = ${JSON.stringify(encoded)};
const data = routes[args[5]];
if (!data) { console.error('SECRET_NO_ROUTE'); process.exit(1); }
process.stdout.write(Buffer.from(data, 'base64'));
`,
      { mode: 0o700 },
    )
  installGh()
  const command = resolve(project, 'scripts/inspect-deployment.ts')
  const args = [
    command,
    '--repo',
    options.repo,
    '--workflow',
    options.workflow,
    '--commit',
    commit,
    '--run',
    '123',
    '--json',
  ]
  const run = () =>
    spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      },
    })
  const success = run()
  assert.equal(success.status, 0, success.stderr)
  const result = JSON.parse(success.stdout)
  t.after(() => rmSync(result.directory, { recursive: true, force: true }))
  assert.equal(result.outcome, 'success')
  delete encoded[`${root}/artifacts/3/zip`]
  installGh()
  const incomplete = run()
  assert.equal(incomplete.status, 1, incomplete.stderr)
  const unavailable = JSON.parse(incomplete.stdout)
  t.after(() => rmSync(unavailable.directory, { recursive: true, force: true }))
  assert.equal(unavailable.outcome, 'incomplete')
  assert.match(unavailable.problems.join(), /artifact download failed/)
  assert.ok(!incomplete.stdout.includes('SECRET_NO_ROUTE'))
  // Force a controlled transport failure, with secret-bearing stderr, in the CLI adapter.
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}\nconsole.error('SECRET_TRANSPORT'); process.exit(1);\n`,
    { mode: 0o700 },
  )
  const error = run()
  assert.equal(error.status, 2)
  const failure = JSON.parse(error.stdout)
  t.after(() => rmSync(failure.directory, { recursive: true, force: true }))
  assert.equal(failure.outcome, 'error')
  assert.ok(!error.stdout.includes('SECRET_TRANSPORT'))
  const invalid = spawnSync(process.execPath, [command, '--commit', 'main'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
  assert.equal(invalid.stdout, '')
})
