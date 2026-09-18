import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
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
const dataApiResumeRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]
const dataApiResumeErrorNames = new Set([
  'DatabaseResumingException',
  'DatabaseUnavailableException',
  'ServiceUnavailableError',
])

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
  const send = (command) => sendWithResumeRetry(client, command)

  const execute = async (sql, parameters = [], transactionId) => {
    return send(
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
    const { transactionId } = await send(new BeginTransactionCommand(base))

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
      await send(new CommitTransactionCommand({ ...base, transactionId }))
    } catch (error) {
      await rollback(send, base, transactionId)
      console.error(`Migration ${migration.tag} failed`)
      throw error
    }
  }
}

function readMigrations() {
  const migrationsDir = join(packageDir, 'drizzle')

  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const query = readFileSync(join(migrationsDir, entry.name, 'migration.sql'), 'utf8')

      return migrationFromSql({
        folderMillis: migrationFolderMillis(entry.name),
        query,
        tag: entry.name,
      })
    })
    .sort((left, right) => left.folderMillis - right.folderMillis)
}

function migrationFromSql({ folderMillis, query, tag }) {
  return {
    folderMillis,
    hash: createHash('sha256').update(query).digest('hex'),
    sql: query.split('--> statement-breakpoint'),
    tag,
  }
}

function migrationFolderMillis(folderName) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(folderName)

  if (!match) {
    throw new Error(`Could not parse migration timestamp from ${folderName}`)
  }

  const [, year, month, day, hour, minute, second] = match.map(Number)

  return Date.UTC(year, month - 1, day, hour, minute, second)
}

async function rollback(send, base, transactionId) {
  try {
    await send(new RollbackTransactionCommand({ ...base, transactionId }))
  } catch (error) {
    console.error('Failed to roll back migration transaction')
    console.error(error)
  }
}

async function sendWithResumeRetry(client, command) {
  for (const [attempt, delayMs] of dataApiResumeRetryDelaysMs.entries()) {
    try {
      return await client.send(command)
    } catch (error) {
      if (!isDataApiResumeError(error)) {
        throw error
      }

      console.warn(`RDS Data API is resuming; retrying query attempt ${attempt + 1}`)
      await delay(delayMs)
    }
  }

  return client.send(command)
}

function isDataApiResumeError(error) {
  return dataApiResumeErrorNames.has(String(error?.name))
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requiredEnv(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }

  return value
}
