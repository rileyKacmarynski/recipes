import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, verifyArtifacts } from './artifacts.mjs'

const exec = promisify(execFile)
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url))

async function workspace() {
  const directory = fileURLToPath(new URL('../../.local/uat/checks/', import.meta.url))
  await mkdir(directory, { recursive: true })
  return mkdtemp(resolve(directory, 'contract-'))
}

async function manifest(directory) {
  await writeFile(
    resolve(directory, 'manifest.json'),
    JSON.stringify({
      version: 1,
      builtAt: new Date().toISOString(),
      files: await fingerprint(directory),
    }),
  )
}

async function run(artifact, output) {
  let code = 0
  try {
    await exec(process.execPath, [runner, artifact, output], { timeout: 240_000 })
  } catch (error) {
    code = error.code
  }
  return { code, report: JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8')) }
}

test('missing supplied artifacts fail with preserved setup evidence, without Docker', async () => {
  const root = await workspace()
  const { code, report } = await run(resolve(root, 'missing'), resolve(root, 'evidence'))
  assert.equal(code, 1)
  assert.equal(report.outcome, 'setup-error')
  assert.deepEqual(report.cleanup, [])
  assert.match(await readFile(resolve(root, 'evidence/summary.txt'), 'utf8'), /ENOENT/)
})

test('invalid handoffs are neither repaired nor accepted', async () => {
  const root = await workspace()
  const artifact = resolve(root, 'artifacts')
  await mkdir(artifact)
  await writeFile(resolve(artifact, 'api.cjs'), 'original')
  await manifest(artifact)
  await assert.rejects(verifyArtifacts(artifact), /Missing artifact/)
  await writeFile(resolve(artifact, 'api.cjs'), 'tampered')
  const { code, report } = await run(artifact, resolve(root, 'evidence'))
  assert.equal(code, 1)
  assert.equal(report.outcome, 'setup-error')
  assert.match(report.error, /checksum mismatch/)
  assert.equal(await readFile(resolve(artifact, 'api.cjs'), 'utf8'), 'tampered')
  assert.deepEqual(report.cleanup, [])
})

// Explicit opt-in: ordinary tests never acquire Docker or browser requirements.
test(
  'acceptance command owns repeated runs, failure evidence, and teardown',
  {
    skip: !process.env.UAT_TEST_ARTIFACTS,
    timeout: 300_000,
  },
  async (t) => {
    const supplied = resolve(process.env.UAT_TEST_ARTIFACTS)
    const original = await verifyArtifacts(supplied)
    const root = await workspace()

    async function assertStopped(report) {
      assert.ok(report.cleanup.length > 0)
      assert.ok(
        report.cleanup.every((entry) => entry.stopped),
        JSON.stringify(report.cleanup),
      )
      if (report.resources.apiPid) {
        assert.throws(() => process.kill(report.resources.apiPid, 0), { code: 'ESRCH' })
      }
      if (report.resources.containerId) {
        assert.throws(() =>
          execFileSync('docker', ['inspect', report.resources.containerId], { stdio: 'pipe' }),
        )
      }
      for (const origin of [report.resources.webOrigin, report.resources.apiOrigin].filter(
        Boolean,
      )) {
        await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1_000) }))
      }
    }

    for (const iteration of [1, 2]) {
      await t.test(`clean run ${iteration}`, async () => {
        const { code, report } = await run(supplied, resolve(root, `pass-${iteration}`))
        assert.equal(code, 0, report.error)
        assert.equal(report.outcome, 'passed')
        assert.equal(report.artifacts.sha256, original.sha256)
        assert.equal(report.scenarios.length, 4)
        assert.ok(report.scenarios.every((scenario) => scenario.passed))
        await assertStopped(report)
      })
    }

    for (const failure of ['startup', 'migration', 'expectation']) {
      await t.test(`${failure} failure`, async () => {
        const fixture = resolve(root, failure)
        await cp(supplied, fixture, { recursive: true })
        if (failure === 'startup') await writeFile(resolve(fixture, 'api.cjs'), 'process.exit(42)')
        if (failure === 'migration') {
          const sql = Object.keys(original.files).find((path) => path.endsWith('/migration.sql'))
          await writeFile(resolve(fixture, sql), 'INVALID SQL FOR FAILURE VALIDATION;')
        }
        if (failure === 'expectation')
          await writeFile(resolve(fixture, 'web/index.html'), '<h1>Broken supplied frontend</h1>')
        await manifest(fixture)
        const output = resolve(root, `${failure}-evidence`)
        const { code, report } = await run(fixture, output)
        assert.equal(code, 1)
        assert.equal(
          report.outcome,
          failure === 'expectation' ? 'expectation-failed' : 'setup-error',
        )
        assert.equal(report.artifacts.sha256, (await verifyArtifacts(fixture)).sha256)
        await assertStopped(report)
        assert.ok((await readFile(resolve(output, 'postgres.log'), 'utf8')).length)
        if (failure === 'expectation') {
          const attachments = report.scenarios.flatMap((scenario) =>
            scenario.results.flatMap((result) =>
              result.results.flatMap((attempt) => attempt.attachments),
            ),
          )
          for (const name of ['screenshot', 'trace']) {
            const attachment = attachments.find((entry) => entry.name === name)
            assert.ok(attachment, `Missing ${name}`)
            assert.ok((await readFile(attachment.path)).length)
          }
        }
      })
    }
    await t.test('SIGTERM during partial API startup cleans up', async () => {
      const fixture = resolve(root, 'interrupted')
      await cp(supplied, fixture, { recursive: true })
      await writeFile(
        resolve(fixture, 'api.cjs'),
        'console.log("Waiting forever"); setInterval(() => {}, 1000)',
      )
      await manifest(fixture)
      const output = resolve(root, 'interrupted-evidence')
      const child = spawn(process.execPath, [runner, fixture, output], { stdio: 'ignore' })
      const exited = once(child, 'exit')
      try {
        const deadline = Date.now() + 30_000
        while (true) {
          try {
            if ((await readFile(resolve(output, 'api.log'), 'utf8')).includes('Waiting forever'))
              break
          } catch {}
          assert.ok(Date.now() < deadline, 'API fixture did not start')
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        child.kill('SIGTERM')
        const [code] = await exited
        assert.equal(code, 1)
        const report = JSON.parse(await readFile(resolve(output, 'report.json'), 'utf8'))
        assert.equal(report.outcome, 'setup-error')
        assert.match(report.error, /interrupted/)
        await assertStopped(report)
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM')
      }
    })
    assert.equal((await verifyArtifacts(supplied)).sha256, original.sha256)
  },
)
