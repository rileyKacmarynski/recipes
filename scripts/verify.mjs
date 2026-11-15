import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

for (const step of ['format', 'lint', 'typecheck', 'test:unit', 'build']) {
  console.log(`\nVerification: pnpm ${step}`)
  const result = spawnSync('pnpm', [step], { cwd: root, stdio: 'inherit' })
  if (result.error || result.signal || result.status !== 0) {
    console.error(`\nVerification failed: pnpm ${step}`)
    if (result.error) console.error(result.error.message)
    if (result.signal) console.error(`Terminated by ${result.signal}`)
    process.exit(result.status || 1)
  }
}

console.log('\nVerification passed: format, lint, typecheck, test:unit, build.')
