import { RDSDataClient, type RDSDataClientConfig } from '@aws-sdk/client-rds-data'
import { drizzle as drizzleDataApi } from 'drizzle-orm/aws-data-api/pg'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

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
