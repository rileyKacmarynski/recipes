import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./verify.mjs', import.meta.url))

function run(t, failStep = '', missingPnpm = false) {
  const directory = mkdtempSync(join(tmpdir(), 'recipes-verify-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const log = join(directory, 'steps')
  if (!missingPnpm) {
    writeFileSync(
      join(directory, 'pnpm'),
      `#!/bin/sh
echo "$1" >> "$VERIFY_TEST_LOG"
echo "Output from $1"
if [ "$1" = "$VERIFY_TEST_FAIL" ]; then exit 7; fi
`,
      { mode: 0o755 },
    )
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: directory,
      VERIFY_TEST_LOG: log,
      VERIFY_TEST_FAIL: failStep,
    },
  })
  return {
    ...result,
    steps: missingPnpm ? [] : readFileSync(log, 'utf8').trim().split('\n'),
  }
}

test('verification runs all standard checks in order and streams their output', (t) => {
  const result = run(t)
  assert.equal(result.status, 0)
  assert.deepEqual(result.steps, ['format', 'lint', 'typecheck', 'test:unit', 'build'])
  assert.match(result.stdout, /Output from build/)
  assert.match(result.stdout, /Verification passed/)
})

test('verification stops at the failed check and reports it without claiming success', (t) => {
  const result = run(t, 'typecheck')
  assert.equal(result.status, 7)
  assert.deepEqual(result.steps, ['format', 'lint', 'typecheck'])
  assert.match(result.stderr, /Verification failed: pnpm typecheck/)
  assert.doesNotMatch(result.stdout, /Verification passed/)
})

test('verification reports a missing runner as a failure', (t) => {
  const result = run(t, '', true)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Verification failed: pnpm format/)
  assert.match(result.stderr, /ENOENT/)
  assert.doesNotMatch(result.stdout, /Verification passed/)
})
