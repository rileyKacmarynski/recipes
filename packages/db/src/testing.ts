import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import { createLocalPostgresClient } from './client'

// No environment-based connection fallback: test cleanup must never touch a developer's database.
export async function createTestDatabase() {
  const container = await new PostgreSqlContainer('postgres:18.1-alpine').start()
  const db = createLocalPostgresClient(container.getConnectionUri())

  async function stop() {
    try {
      await db.$client.end({ timeout: 5 })
    } finally {
      await container.stop()
    }
  }

  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    })

    return { db, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
