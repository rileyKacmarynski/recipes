import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from '@aws-sdk/client-rds-data'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))

if (process.env.DATABASE_DRIVER !== 'data-api') {
  const child = spawn('drizzle-kit', ['migrate', '--config', 'drizzle.config.ts'], {
    cwd: packageDir,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    process.exit(code ?? 1)
  })
} else {
  await migrateDataApi()
}

async function migrateDataApi() {
  const database = requiredEnv('DATABASE_NAME')
  const resourceArn = requiredEnv('DATABASE_RESOURCE_ARN')
  const secretArn = requiredEnv('DATABASE_SECRET_ARN')
  const client = new RDSDataClient({})
  const base = { database, resourceArn, secretArn }

  const execute = async (sql, parameters = [], transactionId) => {
    return client.send(
      new ExecuteStatementCommand({
        ...base,
        continueAfterTimeout: true,
        parameters,
        sql,
        transactionId,
      }),
    )
  }

  await execute('CREATE SCHEMA IF NOT EXISTS "drizzle"')
  await execute(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `)

  const lastMigration = await execute(
    'SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  )
  const lastCreatedAt = Number(lastMigration.records?.[0]?.[2]?.longValue ?? 0)

  for (const migration of readMigrations()) {
    if (lastCreatedAt >= migration.folderMillis) {
      console.log(`Skipping migration ${migration.tag}`)
      continue
    }

    console.log(`Applying migration ${migration.tag}`)
    const { transactionId } = await client.send(new BeginTransactionCommand(base))

    try {
      for (const statement of migration.sql) {
        if (statement.trim()) {
          await execute(statement, [], transactionId)
        }
      }

      await execute(
        'INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES (:hash, :created_at)',
        [
          { name: 'hash', value: { stringValue: migration.hash } },
          { name: 'created_at', value: { longValue: migration.folderMillis } },
        ],
        transactionId,
      )
      await client.send(new CommitTransactionCommand({ ...base, transactionId }))
    } catch (error) {
      await rollback(client, base, transactionId)
      console.error(`Migration ${migration.tag} failed`)
      throw error
    }
  }
}

function readMigrations() {
  const migrationsDir = join(packageDir, 'drizzle')
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8'))

  return journal.entries.map((entry) => {
    const query = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8')

    return {
      folderMillis: entry.when,
      hash: createHash('sha256').update(query).digest('hex'),
      sql: query.split('--> statement-breakpoint'),
      tag: entry.tag,
    }
  })
}

async function rollback(client, base, transactionId) {
  try {
    await client.send(new RollbackTransactionCommand({ ...base, transactionId }))
  } catch (error) {
    console.error('Failed to roll back migration transaction')
    console.error(error)
  }
}

function requiredEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}
