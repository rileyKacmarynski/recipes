import { afterEach, expect, test, vi } from 'vitest'
import { runSmokeTest } from './smokeTest'

const env = {
  API_URL: 'https://recipes-api.example.com',
  CF_ACCESS_SMOKE_CLIENT_ID: 'smoke-client.access',
  CF_ACCESS_SMOKE_CLIENT_SECRET: 'do-not-log-this',
}

afterEach(() => vi.restoreAllMocks())

test.each([
  { recipes: [] },
  { recipes: [{ id: 'b4f6a2be-b211-4ff8-a2ca-bfc5ce85e3a3', title: 'Pancakes' }] },
])('accepts a valid recipe list without requiring seed data: %j', async (body) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
  await expect(runSmokeTest(env)).resolves.toBeUndefined()
})

test('sends service credentials over HTTPS without following redirects', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ recipes: [] }))

  await runSmokeTest(env)

  expect(fetch).toHaveBeenCalledWith(new URL('https://recipes-api.example.com/recipes'), {
    headers: {
      'CF-Access-Client-Id': env.CF_ACCESS_SMOKE_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_SMOKE_CLIENT_SECRET,
    },
    redirect: 'manual',
    signal: expect.any(AbortSignal),
  })
})

test.each([302, 401, 403, 500, 504])(
  'rejects HTTP %i instead of treating it as a working database',
  async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('private server response', { status }),
    )
    await expect(runSmokeTest(env)).rejects.toThrow(`HTTP ${status}`)
  },
)

test.each([
  {},
  { recipes: null },
  { recipes: {} },
  { recipes: [{ id: 'not-a-uuid', title: 'Pancakes' }] },
  { recipes: [{ id: 'b4f6a2be-b211-4ff8-a2ca-bfc5ce85e3a3', title: '' }] },
])('rejects an invalid successful response: %j', async (body) => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
  await expect(runSmokeTest(env)).rejects.toThrow('invalid recipe-list shape')
})

test('rejects an HTML login page even when it returns HTTP 200', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Sign in</html>'))
  await expect(runSmokeTest(env)).rejects.toThrow('did not return JSON')
})

test.each([
  { ...env, API_URL: 'http://recipes-api.example.com' },
  { ...env, API_URL: 'not a URL' },
  { ...env, CF_ACCESS_SMOKE_CLIENT_ID: '' },
  { ...env, CF_ACCESS_SMOKE_CLIENT_SECRET: '' },
])('rejects unsafe or missing configuration before sending credentials', async (config) => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  await expect(runSmokeTest(config)).rejects.toThrow('requires an HTTPS API_URL')
  expect(fetch).not.toHaveBeenCalled()
})

test('does not expose request credentials from a network error', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(env.CF_ACCESS_SMOKE_CLIENT_SECRET))
  await expect(runSmokeTest(env)).rejects.toThrow(
    'DB-backed smoke test could not reach the API within the request timeout',
  )
})
