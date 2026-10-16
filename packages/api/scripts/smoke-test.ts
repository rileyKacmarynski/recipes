import { runSmokeTest } from '../src/deployment/smokeTest'

try {
  await runSmokeTest(process.env)
  console.log('DB-backed smoke test ok: GET /recipes returned a valid recipe list')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'DB-backed smoke test failed')
  process.exitCode = 1
}
