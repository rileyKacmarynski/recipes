import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Config } from './contracts.ts'

const execute = promisify(execFile)
const git = async (root: string, args: string[], signal: AbortSignal) =>
  (
    await execute('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      signal,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim()

async function installDependencies(root: string, signal: AbortSignal) {
  const log = resolve(root, '.local/loop/bootstrap/install.log')
  try {
    const result = await execute(
      'pnpm',
      ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile'],
      {
        cwd: root,
        signal,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: 'true', npm_config_manage_package_manager_versions: 'false' },
      },
    )
    await writeFile(log, result.stdout + result.stderr, { mode: 0o600 })
  } catch {
    // Do not echo dependency-manager errors or fall back to network/lifecycle scripts.
    await writeFile(
      log,
      'Offline dependency setup failed or was interrupted; no network or lifecycle-script fallback was attempted.\n',
      { mode: 0o600 },
    )
    throw new Error(
      'Offline dependency setup failed; populate the pnpm store before starting another slice',
    )
  }
}

/** One fresh workspace per implementation slice; repairs stay in it. Verification inspects its supplied candidate. */
export async function prepareLoopWorkspace(
  config: Config,
  configFile: string,
  signal: AbortSignal,
  setupDependencies = installDependencies,
) {
  const source = config.workspace
  if ((await realpath(source)) !== source)
    throw new Error('Workspace must be a canonical absolute directory')
  if (config.mode === 'verify') return { config, configFile, workspace: null }
  const top = await git(source, ['rev-parse', '--show-toplevel'], signal)
  if ((await realpath(top)) !== source)
    throw new Error('Implementation workspace must be a Git checkout root')
  if (await git(source, ['status', '--porcelain=v1', '--untracked-files=normal'], signal))
    throw new Error(
      'Implementation requires a clean source checkout; preserve/review current changes first, or use verify mode for an existing candidate',
    )
  const evidence = relative(source, config.evidence)
  const bootstrapRelative = `.local${sep}loop${sep}bootstrap`
  if (
    isAbsolute(evidence) ||
    !evidence.startsWith(`.local${sep}loop${sep}`) ||
    evidence === bootstrapRelative ||
    evidence.startsWith(bootstrapRelative + sep)
  )
    throw new Error(
      'Evidence must be a new directory under <workspace>/.local/loop/, outside bootstrap/',
    )
  const contract = await readFile(config.contract, 'utf8')
  if (!contract.trim()) throw new Error('Approved contract is empty')
  for (const input of [config.contract, configFile]) {
    const canonical = await realpath(input)
    if (config.writableFiles.some((path) => resolve(source, path) === canonical))
      throw new Error('Contract or run config cannot alias writable source')
  }
  // All input validation above precedes Git mutation. Never stash, commit, switch or reuse a branch.
  const baseCommit = await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
  const sourceBranch = await git(source, ['branch', '--show-current'], signal)
  const slug =
    config.issue
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'slice'
  const name = `${slug}-${randomUUID()}`
  const branch = `loop/${name}`
  const target = resolve(source, '.worktrees', name)
  await mkdir(resolve(source, '.worktrees'), { recursive: true })
  await git(source, ['worktree', 'add', '-b', branch, target, baseCommit], signal)
  const workspace = { source, sourceBranch, baseCommit, branch, path: target }
  try {
    const bootstrap = resolve(target, '.local/loop/bootstrap')
    await mkdir(bootstrap, { recursive: true, mode: 0o700 })
    const nextConfig = {
      ...config,
      workspace: target,
      contract: resolve(bootstrap, 'contract.md'),
      evidence: resolve(target, evidence),
    }
    const nextFile = resolve(bootstrap, 'run.json')
    await writeFile(
      resolve(bootstrap, 'workspace.json'),
      JSON.stringify(workspace, null, 2) + '\n',
      { mode: 0o600 },
    )
    await writeFile(nextConfig.contract, contract, { mode: 0o600 })
    await writeFile(nextFile, JSON.stringify(nextConfig, null, 2) + '\n', { mode: 0o600 })
    await setupDependencies(target, signal)
    return { config: nextConfig, configFile: nextFile, workspace }
  } catch {
    throw new Error(
      `Loop workspace setup failed. Branch ${branch} and worktree ${target} are retained; inspect .local/loop/bootstrap/. No loop agents started.`,
    )
  }
}
