import type { Context } from 'hono'
import type { AppEnv } from '../env'

export type IdentityContext =
  | { provider: 'local' | 'cloudflare-access'; subject: string; email?: string }
  | { provider: 'cloudflare-access-service'; subject: string; email?: never }

export type AppBindings = {
  Variables: {
    identity?: IdentityContext
  }
}

export type AuthProvider = (c: Context<AppBindings>, env: AppEnv) => Promise<IdentityContext | null>
