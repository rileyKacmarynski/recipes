import { execFileSync } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { fingerprint } from './artifacts.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(process.argv[2] ?? '.local/uat/artifacts')
// Refuse to overwrite an earlier handoff or unrelated user files.
await mkdir(dirname(output), { recursive: true })
await mkdir(output, { recursive: false })
execFileSync('pnpm', ['--filter', '@recipes/web', 'build'], {
  cwd: root,
  env: { ...process.env, VITE_API_URL: '/api' },
  stdio: 'inherit',
})
await cp(resolve(root, 'packages/web/dist'), resolve(output, 'web'), { recursive: true })
for (const [entry, name] of [
  ['packages/api/src/index.ts', 'api'],
  ['packages/db/scripts/migrate-local.ts', 'migrate'],
]) {
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: resolve(output, `${name}.cjs`),
  })
}
await cp(resolve(root, 'packages/db/drizzle'), resolve(output, 'migrations'), { recursive: true })
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      builtAt: new Date().toISOString(),
      files: await fingerprint(output),
    },
    null,
    2,
  ),
)
console.log(`Built artifact handoff: ${output}`)
