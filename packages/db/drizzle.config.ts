import { defineConfig } from 'drizzle-kit'

const databaseDriver = process.env.DATABASE_DRIVER

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  ...(databaseDriver === 'data-api'
    ? {
        driver: 'aws-data-api',
        dbCredentials: {
          database: process.env.DATABASE_NAME ?? 'recipes',
          resourceArn: process.env.DATABASE_RESOURCE_ARN ?? '',
          secretArn: process.env.DATABASE_SECRET_ARN ?? '',
        },
      }
    : {
        dbCredentials: {
          url: process.env.DATABASE_URL ?? 'postgres://recipes:recipes@localhost:5432/recipes',
        },
      }),
})
