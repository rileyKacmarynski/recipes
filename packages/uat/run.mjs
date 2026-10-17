import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { chromium } from '@playwright/test'
import { z } from 'zod'
import { verifyArtifacts } from './artifacts.mjs'
import { serveFrontend } from './server.mjs'

const supplied = process.argv[2]
const artifacts = supplied ? resolve(supplied) : undefined
const evidence = resolve(
  process.argv[3] ??
    `.local/uat/runs/${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`,
)
if (
  artifacts &&
  (evidence === artifacts ||
    evidence.startsWith(artifacts + sep) ||
    artifacts.startsWith(evidence + sep))
) {
  throw new Error('Evidence and artifacts must be separate directories')
}
await mkdir(dirname(evidence), { recursive: true })
await mkdir(evidence, { recursive: false })
const report = {
  startedAt: new Date().toISOString(),
  artifacts: { path: artifacts ?? null },
  outcome: 'setup-error',
  scenarios: [],
  evidence,
  resources: {},
  cleanup: [],
}
const cleanups = []
const attemptSchema = z.looseObject({ status: z.string() })
const suiteSchema = z.object({
  specs: z
    .array(
      z.object({
        title: z.string(),
        tests: z.array(z.looseObject({ results: z.array(attemptSchema) })),
      }),
    )
    .default([]),
  suites: z.array(z.lazy(() => suiteSchema)).default([]),
})
const resultsSchema = z.object({
  suites: z.array(suiteSchema),
  errors: z.array(z.unknown()).default([]),
})
const abort = new AbortController()
const interrupt = () => abort.abort(new Error('UAT interrupted'))
process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

function launch(args, env, name, timeout = 60_000) {
  const child = spawn(process.execPath, args, {
    // Deliberately do not inherit database, auth, cloud, or Node injection settings.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  // Register immediately so partial startup also owns cleanup.
  function kill(signal) {
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  cleanups.push([
    name,
    async () => {
      kill('SIGTERM')
      const timer = setTimeout(() => kill('SIGKILL'), 3_000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
        kill('SIGKILL')
      }
    },
  ])
  appendFileSync(resolve(evidence, `${name}.log`), '')
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => appendFileSync(resolve(evidence, `${name}.log`), data))
  }
  return { child, exited, timeout }
}

async function completed(process) {
  const result = await bounded(process.exited, process.timeout)
  if (result.code !== 0) throw new Error(`Process failed: ${JSON.stringify(result)}`)
}

async function bounded(promise, milliseconds) {
  abort.signal.throwIfAborted()
  let timer
  let onAbort
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${milliseconds}ms`)),
          milliseconds,
        )
        onAbort = () => reject(abort.signal.reason)
        abort.signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    abort.signal.removeEventListener('abort', onAbort)
  }
}

try {
  if (!artifacts) throw new Error('Usage: pnpm uat <artifact-directory> [new-evidence-directory]')
  report.artifacts = { path: artifacts, ...(await verifyArtifacts(artifacts)) }
  // Browser installation failures are setup failures, not product failures.
  const browser = await chromium.launch()
  await browser.close()
  abort.signal.throwIfAborted()
  const container = await new PostgreSqlContainer('postgres:18.1-alpine')
    .withStartupTimeout(60_000)
    .start()
  report.resources.containerId = container.getId()
  cleanups.push([
    'postgres',
    async () => {
      try {
        const logs = spawnSync('docker', ['logs', container.getId()], {
          timeout: 5_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        appendFileSync(
          resolve(evidence, 'postgres.log'),
          Buffer.concat([logs.stdout ?? Buffer.alloc(0), logs.stderr ?? Buffer.alloc(0)]),
        )
        if (logs.error || logs.status !== 0)
          throw logs.error ?? new Error('Could not capture Postgres logs')
      } finally {
        await container.stop()
      }
    },
  ])
  abort.signal.throwIfAborted()
  const env = {
    NODE_ENV: 'development',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: container.getConnectionUri(),
    WEB_ORIGIN: 'http://localhost',
    API_PORT: '0',
  }
  await completed(
    launch(
      [resolve(artifacts, 'migrate.cjs'), resolve(artifacts, 'migrations')],
      env,
      'migrations',
    ),
  )
  const api = launch([resolve(artifacts, 'api.cjs')], env, 'api')
  report.resources.apiPid = api.child.pid
  const apiOrigin = await bounded(
    new Promise((resolve, reject) => {
      let output = ''
      api.child.stdout.on('data', (chunk) => {
        output += chunk
        const match = /API listening on http:\/\/localhost:(\d+)/.exec(output)
        if (match) resolve(`http://127.0.0.1:${match[1]}`)
      })
      api.exited.then(() => reject(new Error('API exited before readiness')), reject)
    }),
    20_000,
  )
  const health = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(5_000) })
  if (!health.ok) throw new Error('API health check failed')
  const frontend = await serveFrontend(resolve(artifacts, 'web'), apiOrigin, (line) =>
    appendFileSync(resolve(evidence, 'frontend.log'), line),
  )
  cleanups.push(['frontend', frontend.stop])
  report.resources.apiOrigin = apiOrigin
  report.resources.webOrigin = frontend.origin
  const playwright = launch(
    [
      fileURLToPath(import.meta.resolve('@playwright/test/cli')),
      'test',
      '--config',
      fileURLToPath(new URL('./playwright.config.mjs', import.meta.url)),
    ],
    { UAT_BASE_URL: frontend.origin, UAT_EVIDENCE: evidence },
    'playwright',
    180_000,
  )
  const result = await bounded(playwright.exited, playwright.timeout)
  const results = resultsSchema.parse(
    JSON.parse(await readFile(resolve(evidence, 'playwright.json'), 'utf8')),
  )
  function collect(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        report.scenarios.push({
          name: spec.title,
          passed:
            spec.tests.length > 0 &&
            spec.tests.every((test) => test.results.at(-1)?.status === 'passed'),
          results: spec.tests,
        })
      }
      collect(suite.suites ?? [])
    }
  }
  collect(results.suites)
  if (results.errors?.length || !report.scenarios.length)
    throw new Error('Playwright did not complete acceptance scenarios')
  report.outcome =
    result.code === 0 && report.scenarios.every((scenario) => scenario.passed)
      ? 'passed'
      : 'expectation-failed'
  // Detect any mutation of the supplied handoff during verification.
  const finalArtifacts = await verifyArtifacts(artifacts)
  if (finalArtifacts.sha256 !== report.artifacts.sha256) {
    throw new Error('Supplied artifact identity changed during verification')
  }
} catch (error) {
  report.outcome = 'setup-error'
  report.error = error.stack ?? String(error)
} finally {
  for (const [name, stop] of cleanups.reverse()) {
    try {
      await stop()
      report.cleanup.push({ resource: name, stopped: true })
    } catch (error) {
      report.cleanup.push({ resource: name, stopped: false, error: String(error) })
      report.outcome = 'setup-error'
    }
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2))
  const summary =
    [
      `UAT: ${report.outcome}`,
      `Artifacts: ${artifacts ?? '(not supplied)'}`,
      `SHA-256: ${report.artifacts.sha256 ?? '(unverified)'}`,
      ...report.scenarios.map(
        (scenario) => `${scenario.passed ? 'PASS' : 'FAIL/SKIP'} ${scenario.name}`,
      ),
      ...(report.error ? [report.error] : []),
      `Cleanup: ${JSON.stringify(report.cleanup)}`,
      `Evidence: ${evidence}`,
    ].join('\n') + '\n'
  await writeFile(resolve(evidence, 'summary.txt'), summary)
  console.log(summary)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  process.exitCode = report.outcome === 'passed' ? 0 : 1
}
