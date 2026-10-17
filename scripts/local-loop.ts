import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configSchema } from './local-loop/contracts.ts'
import { runLoop } from './local-loop/coordinator.ts'
import { localRuntime } from './local-loop/runtime.ts'

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: pnpm loop <approved-run-config.json>')
  const file = resolve(process.argv[2]!)
  const config = configSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  config.workspace = resolve(config.workspace)
  config.contract = resolve(config.workspace, config.contract)
  config.evidence = resolve(config.workspace, config.evidence)
  if (config.workspace !== fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''))
    throw new Error('Run this coordinator from the explicit workspace that contains it')
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error('Operator interrupted'))
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    const report = await runLoop(config, localRuntime(config, file), controller.signal)
    console.log(`${report.outcome}: ${report.reason}\nReport: ${config.evidence}/report.md`)
    process.exitCode = report.outcome === 'proposed-pass' ? 0 : 1
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
