import type { Context } from 'hono'
import type { AppEnv } from '../env'

export type IdentityContext = {
  provider: 'local' | 'cloudflare-access'
  subject: string
  email?: string
}

export type AppBindings = {
  Variables: {
    identity?: IdentityContext
  }
}

export type AuthProvider = (c: Context<AppBindings>, env: AppEnv) => Promise<IdentityContext | null>
