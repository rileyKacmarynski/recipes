import { serve } from '@hono/node-server'
import { createRecipes } from '@recipes/core'
import { createDbFromEnv } from '@recipes/db'
import { createApp } from './app'
import { cloudflareAuthProvider } from './auth/cloudflareAuthProvider'
import { localAuthProvider } from './auth/localAuthProvider'
import { parseAppEnv } from './env'

const port = Number(process.env.API_PORT ?? 3000)
const env = parseAppEnv(process.env)
const db = createDbFromEnv(env)
const app = createApp({
  env,
  authProvider: env.NODE_ENV === 'development' ? localAuthProvider : cloudflareAuthProvider,
  recipes: createRecipes(db),
})

serve({
  fetch: app.fetch,
  port,
})

console.log(`API listening on http://localhost:${port}`)
