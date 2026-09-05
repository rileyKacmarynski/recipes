import { RDSDataClient, type RDSDataClientConfig } from '@aws-sdk/client-rds-data'
import { drizzle as drizzleDataApi } from 'drizzle-orm/aws-data-api/pg'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const localDatabaseUrl = 'postgres://recipes:recipes@localhost:5432/recipes'

export type DatabaseEnv = {
  DATABASE_DRIVER?: 'postgres' | 'data-api'
  DATABASE_NAME?: string
  DATABASE_RESOURCE_ARN?: string
  DATABASE_SECRET_ARN?: string
  DATABASE_URL?: string
  NODE_ENV: string
}

export function createLocalPostgresClient(databaseUrl: string) {
  const client = postgres(databaseUrl)

  return drizzlePostgres(client, { schema })
}

export type LocalPostgresClient = ReturnType<typeof createLocalPostgresClient>

export type DataApiClientOptions = {
  database: string
  resourceArn: string
  secretArn: string
  rdsDataClientConfig?: RDSDataClientConfig
}

export function createDataApiClient({
  database,
  resourceArn,
  rdsDataClientConfig,
  secretArn,
}: DataApiClientOptions) {
  const client = rdsDataClientConfig ? new RDSDataClient(rdsDataClientConfig) : new RDSDataClient()

  return drizzleDataApi(client, {
    database,
    resourceArn,
    schema,
    secretArn,
  })
}

export type DataApiClient = ReturnType<typeof createDataApiClient>
export type RecipesDatabase = LocalPostgresClient | DataApiClient

export function createDbFromEnv(env: DatabaseEnv): RecipesDatabase {
  const databaseDriver =
    env.DATABASE_DRIVER ?? (env.NODE_ENV === 'development' ? 'postgres' : 'data-api')

  if (databaseDriver === 'postgres') {
    return createLocalPostgresClient(env.DATABASE_URL ?? localDatabaseUrl)
  }

  if (!env.DATABASE_NAME || !env.DATABASE_RESOURCE_ARN || !env.DATABASE_SECRET_ARN) {
    throw new Error(
      'DATABASE_NAME, DATABASE_RESOURCE_ARN, and DATABASE_SECRET_ARN are required for data-api',
    )
  }

  return createDataApiClient({
    database: env.DATABASE_NAME,
    resourceArn: env.DATABASE_RESOURCE_ARN,
    secretArn: env.DATABASE_SECRET_ARN,
  })
}
