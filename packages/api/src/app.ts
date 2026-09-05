import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createRecipeSchema, type Recipes } from '@recipes/core'
import type { AppEnv } from './env'
import type { AppBindings, AuthProvider } from './auth/auth'
import { zValidator } from './validation'

type AppOptions = {
  env: AppEnv
  authProvider: AuthProvider
  recipes: Recipes
}

export function createApp({ env, authProvider, recipes }: AppOptions) {
  const configuredWebOrigins = (env.WEB_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return new Hono<AppBindings>()
    .use(
      '*',
      cors({
        origin: (origin) => {
          if (configuredWebOrigins.includes(origin) || origin.startsWith('http://localhost:')) {
            return origin
          }

          return null
        },
        credentials: true,
      }),
    )
    .use('*', async (c, next) => {
      if (c.req.method === 'OPTIONS' || c.req.path === '/health') {
        await next()
        return
      }

      const identity = await authProvider(c, env)

      if (!identity) {
        return c.json({ error: 'Unauthenticated' }, 401)
      }

      c.set('identity', identity)

      await next()
    })
    .get('/health', (c) => c.json({ ok: true }))
    .get('/me', (c) => {
      const identity = c.get('identity')

      if (!identity) {
        return c.json({ error: 'Unauthenticated' }, 401)
      }

      return c.json({ identity })
    })
    .get('/recipes', async (c) => c.json({ recipes: await recipes.list() }))
    .post('/recipes', zValidator('json', createRecipeSchema), async (c) => {
      const recipe = await recipes.create(c.req.valid('json'))

      return c.json({ recipe }, 201)
    })
}
