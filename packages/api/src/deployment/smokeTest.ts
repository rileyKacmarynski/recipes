import { recipeSchema } from '@recipes/core'
import { z } from 'zod'

const smokeEnvSchema = z.object({
  API_URL: z.url().refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  }),
  CF_ACCESS_SMOKE_CLIENT_ID: z.string().min(1),
  CF_ACCESS_SMOKE_CLIENT_SECRET: z.string().min(1),
})
const recipesResponseSchema = z.object({ recipes: z.array(recipeSchema) })

export async function runSmokeTest(env: NodeJS.ProcessEnv) {
  const parsed = smokeEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error('Smoke test requires an HTTPS API_URL and Cloudflare smoke client credentials')
  }
  const config = parsed.data

  let response: Response
  try {
    response = await fetch(new URL('/recipes', config.API_URL), {
      headers: {
        'CF-Access-Client-Id': config.CF_ACCESS_SMOKE_CLIENT_ID,
        'CF-Access-Client-Secret': config.CF_ACCESS_SMOKE_CLIENT_SECRET,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    // Do not print request objects, headers, or errors that may contain credentials.
    throw new Error('DB-backed smoke test could not reach the API within the request timeout')
  }

  if (response.status !== 200) {
    throw new Error(`DB-backed smoke test failed: GET /recipes returned HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('DB-backed smoke test failed: GET /recipes did not return JSON')
  }

  if (!recipesResponseSchema.safeParse(body).success) {
    throw new Error(
      'DB-backed smoke test failed: GET /recipes returned an invalid recipe-list shape',
    )
  }
}
