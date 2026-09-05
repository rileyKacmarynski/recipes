import { handle } from 'hono/aws-lambda'
import { createRecipes } from '@recipes/core'
import { createDbFromEnv } from '@recipes/db'
import { createApp } from './app'
import { cloudflareAuthProvider } from './auth/cloudflareAuthProvider'
import { localAuthProvider } from './auth/localAuthProvider'
import { parseAppEnv } from './env'

const env = parseAppEnv(process.env)
const db = createDbFromEnv(env)
const app = createApp({
  env,
  authProvider: env.NODE_ENV === 'development' ? localAuthProvider : cloudflareAuthProvider,
  recipes: createRecipes(db),
})

export const handler = handle(app)
