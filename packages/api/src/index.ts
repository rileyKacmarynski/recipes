import { serve } from '@hono/node-server'
import { createApp } from './app'
import { cloudflareAuthProvider } from './auth/cloudflareAuthProvider'
import { localAuthProvider } from './auth/localAuthProvider'
import { parseAppEnv } from './env'

const port = Number(process.env.API_PORT ?? 3000)
const env = parseAppEnv(process.env)
const app = createApp({
  env,
  authProvider: env.NODE_ENV === 'development' ? localAuthProvider : cloudflareAuthProvider,
})

serve({
  fetch: app.fetch,
  port,
})

console.log(`API listening on http://localhost:${port}`)
