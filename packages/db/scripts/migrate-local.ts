import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

async function main() {
  if (!process.env.DATABASE_URL || !process.argv[2]) {
    throw new Error('DATABASE_URL and supplied migrations directory are required')
  }
  const client = postgres(process.env.DATABASE_URL)
  try {
    await migrate(drizzle({ client }), { migrationsFolder: process.argv[2] })
  } finally {
    await client.end({ timeout: 5 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
