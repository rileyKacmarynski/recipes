// Seatbelt is inherited by descendants. No writable profile is passed to the child.
// This deliberately supports macOS only and fails closed elsewhere.
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

const quoted = (path) => JSON.stringify(path)
const canonical = (path) => {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return resolve(canonical(dirname(path)), basename(path))
  }
}
const paths = (values) => values.map((path) => `(subpath ${quoted(canonical(path))})`).join(' ')

export function sandboxCommand(
  command,
  args,
  { readable, writable, hidden = [], databasePort, listen = false },
) {
  if (process.platform !== 'darwin')
    throw new Error('Local loop requires validated macOS sandbox-exec isolation')
  if (
    databasePort !== undefined &&
    (!Number.isInteger(databasePort) || databasePort < 1 || databasePort > 65535)
  )
    throw new Error('Invalid sandbox database port')
  for (const path of writable)
    if (canonical(path) !== resolve(path))
      throw new Error(`Writable sandbox paths must not contain symlinks: ${path}`)
  const profile = `(version 3)
    (allow default)
    (deny file-write*)
    (allow file-write* (literal "/dev/null") ${paths(writable)})
    (deny file-read-data (subpath "/Users") (subpath "/private/var/folders"))
    (allow file-read-data ${readable.map((path) => `(require-all (subpath ${quoted(canonical(path))}) ${hidden.map((entry) => `(require-not (subpath ${quoted(canonical(entry))}))`).join(' ')})`).join(' ')} ${paths(writable)})
    (deny network*)
    ${databasePort ? `(allow network-outbound (remote tcp "localhost:${databasePort}"))` : ''}
    ${listen ? '(allow network-inbound (local tcp "localhost:*")) (allow network-bind (local tcp "localhost:*"))' : ''}
    (deny signal)
    (allow signal (target children))
    (deny mach* ipc* iokit* process*)
    (allow process-exec process-fork process-info*)
    ; posix_spawn flags can create a new session without a setsid syscall. Force
    ; callers to fork/exec, then deny session/process-group changes in descendants.
    (deny syscall-unix (syscall-number SYS_posix_spawn) (with errno ENOSYS))
    (deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid))
    (deny appleevent-send)
    `
  return ['/usr/bin/sandbox-exec', ['-p', profile, command, ...args]]
}

export function cleanEnvironment(scratch) {
  return {
    PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    pnpm_config_verify_deps_before_run: 'error',
    LOCAL_LOOP_SANDBOXED: '1',
  }
}

export async function validateSandbox(directory) {
  directory = realpathSync(directory)
  const scratch = resolve(directory, 'scratch')
  await mkdir(scratch, { recursive: true })
  const protectedFile = resolve(directory, 'protected.txt')
  await writeFile(protectedFile, 'protected')
  await symlink(protectedFile, resolve(scratch, 'escape'))
  const code = `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    fs.writeFileSync(${JSON.stringify(resolve(scratch, 'allowed'))}, 'yes');
    for (const path of ${JSON.stringify([protectedFile, resolve(scratch, 'escape')])}) {
      let denied = false; try { fs.writeFileSync(path, 'changed') } catch { denied = true }
      if (!denied) process.exit(41);
    }
    try {
      fs.linkSync(${JSON.stringify(protectedFile)}, ${JSON.stringify(resolve(scratch, 'hardlink'))});
      try { fs.writeFileSync(${JSON.stringify(resolve(scratch, 'hardlink'))}, 'changed'); process.exit(47) } catch {}
    } catch {}
    const child = cp.spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(' +
      JSON.stringify(${JSON.stringify(protectedFile)}) + ', "changed")']);
    if (child.status === 0) process.exit(42);
    const nested = cp.spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)',
      process.execPath, '-e', 'require("node:fs").writeFileSync(' + JSON.stringify(${JSON.stringify(protectedFile)}) + ', "changed")']);
    if (nested.status === 0) process.exit(48);
    const detached = cp.spawnSync('/usr/bin/perl', ['-e', 'print getpgrp'], {detached:true, encoding:'utf8'});
    if (detached.status !== 0 || Number(detached.stdout) !== process.pid) process.exit(49);
    try { process.kill(${process.pid}, 0); process.exit(43) } catch {}
    const net = require('node:net');
    const socket = net.connect({host:'127.0.0.1', port:9});
    socket.on('error', e => process.exit(['EPERM','EACCES'].includes(e.code) ? 0 : 44));
    socket.on('connect', () => process.exit(45));
    setTimeout(() => process.exit(46), 2000);
  `
  const [command, args] = sandboxCommand(process.execPath, ['-e', code], {
    readable: [directory, dirname(process.execPath)],
    writable: [scratch],
  })
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: cleanEnvironment(scratch),
      detached: true,
      timeout: 10_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stderr.on('data', (data) => {
      output += data
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      resolve({ code, signal, output })
    })
  })
  if (result.code !== 0 || (await readFile(protectedFile, 'utf8')) !== 'protected')
    throw new Error(`Sandbox enforcement probe failed: ${JSON.stringify(result)}`)
  return {
    platform: process.platform,
    checkedAt: new Date().toISOString(),
    probes: [
      'write',
      'symlink',
      'hardlink',
      'descendant',
      'nested-sandbox',
      'process-group',
      'signal',
      'network',
    ],
  }
}
