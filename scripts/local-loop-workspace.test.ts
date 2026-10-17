import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { test, type TestContext } from 'node:test'
import { configSchema } from './local-loop/contracts.ts'
import { prepareLoopWorkspace } from './local-loop/workspace.ts'

const signal = () => new AbortController().signal
const git = (root: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Loop Fixture',
      '-c',
      'user.email=loop@example.invalid',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'loop-workspace-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '--initial-branch=existing-slice')
  await mkdir(resolve(root, 'packages/core/src'), { recursive: true })
  await writeFile(resolve(root, 'packages/core/src/index.ts'), 'export const original = true\n')
  await writeFile(resolve(root, '.gitignore'), '.local/\n.worktrees/\nnode_modules/\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'Controlled fixture baseline')
  await mkdir(resolve(root, '.local/loop'), { recursive: true })
  const config = configSchema.parse({
    workspace: root,
    issue: '#42 / new slice',
    contract: resolve(root, '.local/loop/approved.md'),
    evidence: resolve(root, '.local/loop/run-1'),
    model: 'openai/fixture',
    scenarios: ['approved scenario'],
    writableFiles: ['packages/core/src/index.ts'],
  })
  const configFile = resolve(root, '.local/loop/approved.json')
  await writeFile(config.contract, '# Approved contract\n')
  await writeFile(configFile, JSON.stringify(config))
  return { root, config, configFile }
}

test('each implementation slice gets a new branch/worktree at exact HEAD, leaving source checkout and index untouched', async (t) => {
  const { root, config, configFile } = await fixture(t)
  const head = git(root, 'rev-parse', 'HEAD')
  const index = await readFile(resolve(root, '.git/index'))
  let installs = 0
  const install = async (workspace: string) => {
    installs++
    assert.notEqual(workspace, root)
    assert.equal(git(workspace, 'rev-parse', 'HEAD'), head)
    assert.match(git(workspace, 'branch', '--show-current'), /^loop\/42-new-slice-/)
  }
  const first = await prepareLoopWorkspace(config, configFile, signal(), install)
  assert.ok(first.workspace)
  assert.equal(first.workspace.baseCommit, head)
  assert.equal(first.workspace.sourceBranch, 'existing-slice')
  assert.equal(first.config.workspace, first.workspace.path)
  assert.equal(first.config.evidence, resolve(first.config.workspace, '.local/loop/run-1'))
  assert.equal(await readFile(first.config.contract, 'utf8'), '# Approved contract\n')
  assert.deepEqual(JSON.parse(await readFile(first.configFile, 'utf8')), first.config)
  assert.deepEqual(
    JSON.parse(
      await readFile(
        resolve(first.config.workspace, '.local/loop/bootstrap/workspace.json'),
        'utf8',
      ),
    ),
    first.workspace,
  )
  await writeFile(
    resolve(first.config.workspace, 'packages/core/src/index.ts'),
    'export const original = false\n',
  )
  const second = await prepareLoopWorkspace(config, configFile, signal(), install)
  assert.notEqual(second.workspace!.branch, first.workspace.branch)
  assert.notEqual(second.config.workspace, first.config.workspace)
  assert.equal(installs, 2)
  assert.equal(git(root, 'branch', '--show-current'), 'existing-slice')
  assert.equal(git(root, 'rev-parse', 'HEAD'), head)
  assert.equal(git(root, 'status', '--porcelain'), '')
  assert.deepEqual(await readFile(resolve(root, '.git/index')), index)
  assert.equal(
    await readFile(resolve(root, 'packages/core/src/index.ts'), 'utf8'),
    'export const original = true\n',
  )
})

test('verify-only inspects the existing candidate without creating branches, worktrees or installing anything', async (t) => {
  const { root, config, configFile } = await fixture(t)
  await writeFile(resolve(root, 'packages/core/src/index.ts'), 'existing uncommitted candidate\n')
  const before = git(root, 'worktree', 'list', '--porcelain')
  const prepared = await prepareLoopWorkspace(
    { ...config, mode: 'verify', writableFiles: [] },
    configFile,
    signal(),
    async () => {
      assert.fail('Verification must not provision a workspace')
    },
  )
  assert.equal(prepared.config.workspace, root)
  assert.equal(prepared.configFile, configFile)
  assert.equal(prepared.workspace, null)
  assert.equal(git(root, 'worktree', 'list', '--porcelain'), before)
  assert.equal(
    await readFile(resolve(root, 'packages/core/src/index.ts'), 'utf8'),
    'existing uncommitted candidate\n',
  )
})

test('dirty staged, unstaged and untracked source is rejected without stashing, dropping changes or creating branches', async (t) => {
  for (const change of ['staged', 'unstaged', 'untracked']) {
    const { root, config, configFile } = await fixture(t)
    const path = resolve(root, change === 'untracked' ? 'new.txt' : 'packages/core/src/index.ts')
    await writeFile(path, 'KEEP THIS WORK\n')
    if (change === 'staged') git(root, 'add', '.')
    const status = git(root, 'status', '--porcelain')
    const branches = git(root, 'branch', '--list')
    await assert.rejects(
      prepareLoopWorkspace(config, configFile, signal(), async () => {
        assert.fail('No install')
      }),
      /clean source checkout/,
    )
    assert.equal(git(root, 'branch', '--list'), branches)
    assert.equal(git(root, 'status', '--porcelain'), status)
    assert.equal(await readFile(path, 'utf8'), 'KEEP THIS WORK\n')
  }
})

test('invalid contract/evidence/config aliases stop before creating a slice', async (t) => {
  const { root, config, configFile } = await fixture(t)
  const branches = git(root, 'branch', '--list')
  for (const bad of [
    { ...config, evidence: resolve(root, '../outside') },
    { ...config, evidence: resolve(root, '.local/loop/bootstrap/overwrite') },
    { ...config, contract: resolve(root, 'packages/core/src/index.ts') },
    { ...config, contract: resolve(root, 'missing.md') },
  ])
    await assert.rejects(
      prepareLoopWorkspace(bad, configFile, signal(), async () => {
        assert.fail('No install')
      }),
    )
  await assert.rejects(
    prepareLoopWorkspace(
      config,
      resolve(root, 'packages/core/src/index.ts'),
      signal(),
      async () => {
        assert.fail('No install')
      },
    ),
    /alias writable source/,
  )
  assert.equal(git(root, 'branch', '--list'), branches)
})

test('failed setup retains its fresh branch/worktree and provenance rather than deleting evidence or reusing the source', async (t) => {
  const { root, config, configFile } = await fixture(t)
  let target = ''
  await assert.rejects(
    prepareLoopWorkspace(config, configFile, signal(), async (workspace) => {
      target = workspace
      throw new Error('Controlled offline install failure')
    }),
    /retained.*No loop agents started/,
  )
  assert.ok(target)
  const provenance = JSON.parse(
    await readFile(resolve(target, '.local/loop/bootstrap/workspace.json'), 'utf8'),
  )
  assert.equal(provenance.path, target)
  assert.equal(git(target, 'branch', '--show-current'), provenance.branch)
  assert.equal(git(root, 'branch', '--show-current'), 'existing-slice')
  assert.equal(git(root, 'status', '--porcelain'), '')
})

test('real startup adapter installs only offline/frozen with scripts and pnpmfile hooks disabled in the new worktree', async (t) => {
  const { root, configFile } = await fixture(t)
  const bin = resolve(root, '.local/bin')
  await mkdir(bin)
  await writeFile(
    resolve(bin, 'pnpm'),
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('.local/loop/bootstrap/install-args.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
console.log('controlled offline install');
`,
    { mode: 0o700 },
  )
  const module = pathToFileURL(resolve('scripts/local-loop/workspace.ts')).href
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import { readFile } from 'node:fs/promises';
import { prepareLoopWorkspace } from ${JSON.stringify(module)};
const configFile = ${JSON.stringify(configFile)};
const config = JSON.parse(await readFile(configFile, 'utf8'));
const prepared = await prepareLoopWorkspace(config, configFile, new AbortController().signal);
console.log(JSON.stringify(prepared));
`,
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  )
  const prepared = JSON.parse(output)
  const args = JSON.parse(
    await readFile(
      resolve(prepared.config.workspace, '.local/loop/bootstrap/install-args.json'),
      'utf8',
    ),
  )
  assert.equal(args.cwd, prepared.config.workspace)
  assert.deepEqual(args.args, [
    'install',
    '--offline',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--ignore-pnpmfile',
  ])
  assert.equal(
    await readFile(resolve(prepared.config.workspace, '.local/loop/bootstrap/install.log'), 'utf8'),
    'controlled offline install\n',
  )
  assert.equal(git(root, 'branch', '--show-current'), 'existing-slice')
})
