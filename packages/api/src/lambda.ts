import { handle } from 'hono/aws-lambda'
import { createApp } from './app'
import { cloudflareAuthProvider } from './auth/cloudflareAuthProvider'
import { localAuthProvider } from './auth/localAuthProvider'
import { parseAppEnv } from './env'

const env = parseAppEnv(process.env)
const app = createApp({
  env,
  authProvider: env.NODE_ENV === 'development' ? localAuthProvider : cloudflareAuthProvider,
})

export const handler = handle(app)
