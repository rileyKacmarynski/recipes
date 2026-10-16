import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRecipes, type CreateRecipe, type Recipe, type Recipes } from '@recipes/core'
import { recipes as recipesTable } from '@recipes/db'
import type { createTestDatabase } from '@recipes/db/testing'
import { createApp } from './app'
import { cloudflareAuthProvider } from './auth/cloudflareAuthProvider'
import type { AuthProvider } from './auth/auth'
import { localAuthProvider } from './auth/localAuthProvider'
import { parseAppEnv, type AppEnv } from './env'

const developmentEnv: AppEnv = {
  NODE_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:5173',
}

const productionEnv: AppEnv = {
  CLOUDFLARE_ACCESS_AUD: 'expected-aud',
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://recipes.rkac.dev',
}

const unauthenticatedAuthProvider: AuthProvider = async () => null
const runDbTests = process.env.RUN_DB_TESTS === '1'

afterEach(() => {
  vi.restoreAllMocks()
})

async function createAccessToken(
  overrides: {
    aud?: string
    issuer?: string
    claims?: Record<string, unknown>
    expired?: boolean
  } = {},
) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'test-key'

  const token = await new SignJWT(
    overrides.claims ?? { email: 'owner@example.com', sub: 'owner-subject' },
  )
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? 'https://team.cloudflareaccess.com')
    .setAudience(overrides.aud ?? 'expected-aud')
    .setExpirationTime(overrides.expired ? '-1s' : '1h')
    .sign(privateKey)

  return {
    token,
    publicJwk,
  }
}

test('GET /health returns ok without authenticating', async () => {
  const testApp = createTestApp({
    authProvider: unauthenticatedAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/health')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true })
})

test('GET /recipes returns recipes from the recipe module', async () => {
  const testApp = createTestApp({
    authProvider: localAuthProvider,
    env: developmentEnv,
    recipes: createFakeRecipes([{ id: 'recipe-1', title: 'Pancakes' }]),
  })

  const response = await testApp.request('/recipes')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    recipes: [{ id: 'recipe-1', title: 'Pancakes' }],
  })
})

test('POST /recipes validates and creates a recipe', async () => {
  const testApp = createTestApp({
    authProvider: localAuthProvider,
    env: developmentEnv,
    recipes: createFakeRecipes(),
  })

  const response = await testApp.request('/recipes', {
    method: 'POST',
    body: JSON.stringify({ title: '  Pancakes  ' }),
    headers: { 'content-type': 'application/json' },
  })

  expect(response.status).toBe(201)
  await expect(response.json()).resolves.toEqual({
    recipe: { id: 'recipe-1', title: 'Pancakes' },
  })
})

test('POST /recipes rejects invalid recipe input with the schema message', async () => {
  const testApp = createTestApp({
    authProvider: localAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/recipes', {
    method: 'POST',
    body: JSON.stringify({ title: '   ' }),
    headers: { 'content-type': 'application/json' },
  })

  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toEqual({ error: 'Recipe title is required' })
})

describe.skipIf(!runDbTests)('DB-backed recipe routes', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined
  let recipes: Recipes

  beforeAll(async () => {
    const { createTestDatabase } = await import('@recipes/db/testing')
    database = await createTestDatabase()
    recipes = createRecipes(database.db)
  }, 120_000)

  afterAll(async () => {
    await database?.stop()
  }, 30_000)

  beforeEach(async () => {
    await database!.db.delete(recipesTable)
  })

  test('GET /recipes returns an empty list in a fresh database', async () => {
    const testApp = createTestApp({
      authProvider: localAuthProvider,
      env: developmentEnv,
      recipes,
    })

    const response = await testApp.request('/recipes')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ recipes: [] })
  })

  test('creates and lists recipes through the HTTP API', async () => {
    const testApp = createTestApp({
      authProvider: localAuthProvider,
      env: developmentEnv,
      recipes,
    })

    const createResponse = await testApp.request('/recipes', {
      method: 'POST',
      body: JSON.stringify({ title: '  Pancakes  ' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(createResponse.status).toBe(201)
    const createBody = (await createResponse.json()) as { recipe: Recipe }
    expect(createBody).toEqual({
      recipe: { id: expect.any(String), title: 'Pancakes' },
    })

    const listResponse = await testApp.request('/recipes')

    expect(listResponse.status).toBe(200)
    const listBody = (await listResponse.json()) as { recipes: Recipe[] }
    expect(listBody.recipes).toEqual([createBody.recipe])
  })
})

test('GET /me returns the authenticated identity', async () => {
  const testApp = createTestApp({
    authProvider: localAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/me')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    identity: {
      provider: 'local',
      subject: 'local@domain.com',
      email: 'local@domain.com',
    },
  })
})

test('GET /recipes rejects requests without an identity', async () => {
  const testApp = createTestApp({
    authProvider: unauthenticatedAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/recipes')

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: 'Unauthenticated' })
})

test('GET /recipes allows local development auth provider', async () => {
  const testApp = createTestApp({
    authProvider: localAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/recipes')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    recipes: [{ id: 'starter', title: 'Starter Recipe' }],
  })
})

test('GET /recipes rejects missing Cloudflare Access JWTs', async () => {
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: productionEnv,
  })

  const response = await testApp.request('/recipes', {
    headers: {
      origin: 'https://recipes.rkac.dev',
      referer: 'https://recipes.rkac.dev/',
    },
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: 'Unauthenticated' })
})

test('GET /recipes rejects invalid Cloudflare Access JWTs', async () => {
  const { token, publicJwk } = await createAccessToken({ aud: 'wrong-aud' })
  mockCloudflareJwks(publicJwk)

  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: productionEnv,
  })

  const response = await testApp.request('/recipes', {
    headers: { 'cf-access-jwt-assertion': token },
  })

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: 'Unauthenticated' })
})

test('GET /recipes accepts valid Cloudflare Access JWTs', async () => {
  const { token, publicJwk } = await createAccessToken()
  mockCloudflareJwks(publicJwk)

  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: productionEnv,
  })

  const response = await testApp.request('/recipes', {
    headers: { 'cf-access-jwt-assertion': token },
  })

  expect(response.status).toBe(200)
})

test('the configured Cloudflare service can read recipes but cannot write or read user identity', async () => {
  const { token, publicJwk } = await createAccessToken({
    claims: { common_name: 'smoke-client.access', sub: '' },
  })
  mockCloudflareJwks(publicJwk)
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: { ...productionEnv, CLOUDFLARE_SMOKE_CLIENT_ID: 'smoke-client.access' },
    recipes: createFakeRecipes(),
  })
  const headers = { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' }

  const read = await testApp.request('/recipes', { headers })
  expect(read.status).toBe(200)
  await expect(read.json()).resolves.toEqual({ recipes: [] })

  const write = await testApp.request('/recipes', {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Must not be saved' }),
  })
  expect(write.status).toBe(403)
  await expect(write.json()).resolves.toEqual({ error: 'Forbidden' })
  expect((await testApp.request('/me', { headers })).status).toBe(403)
  expect((await testApp.request('/recipes', { method: 'HEAD', headers })).status).toBe(403)

  const afterWrite = await testApp.request('/recipes', { headers })
  await expect(afterWrite.json()).resolves.toEqual({ recipes: [] })
})

test.each([
  {
    name: 'unconfigured service',
    clientId: undefined,
    claims: { common_name: 'smoke-client.access', sub: '' },
  },
  {
    name: 'different service',
    clientId: 'expected.access',
    claims: { common_name: 'other.access', sub: '' },
  },
  { name: 'empty user subject', clientId: undefined, claims: { sub: '' } },
  {
    name: 'malformed service claim',
    clientId: 'expected.access',
    claims: { common_name: 123, sub: 'owner-subject' },
  },
  {
    name: 'mixed service and user claims',
    clientId: 'expected.access',
    claims: { common_name: 'expected.access', sub: 'owner-subject' },
  },
])('GET /recipes rejects $name', async ({ clientId, claims }) => {
  const { token, publicJwk } = await createAccessToken({ claims })
  mockCloudflareJwks(publicJwk)
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: { ...productionEnv, CLOUDFLARE_SMOKE_CLIENT_ID: clientId },
  })

  const response = await testApp.request('/recipes', {
    headers: { 'cf-access-jwt-assertion': token },
  })
  expect(response.status).toBe(401)
})

test.each([
  { name: 'wrong audience', aud: 'wrong-aud' },
  { name: 'wrong issuer', issuer: 'https://other.cloudflareaccess.com' },
  { name: 'expired token', expired: true },
])('service authentication rejects $name', async (overrides) => {
  const { token, publicJwk } = await createAccessToken({
    ...overrides,
    claims: { common_name: 'smoke-client.access', sub: '' },
  })
  mockCloudflareJwks(publicJwk)
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: { ...productionEnv, CLOUDFLARE_SMOKE_CLIENT_ID: 'smoke-client.access' },
  })

  const response = await testApp.request('/recipes', {
    headers: { 'cf-access-jwt-assertion': token },
  })
  expect(response.status).toBe(401)
})

test('normal Cloudflare users retain recipe write access with service auth configured', async () => {
  const { token, publicJwk } = await createAccessToken()
  mockCloudflareJwks(publicJwk)
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: { ...productionEnv, CLOUDFLARE_SMOKE_CLIENT_ID: 'smoke-client.access' },
  })

  const response = await testApp.request('/recipes', {
    method: 'POST',
    headers: { 'cf-access-jwt-assertion': token, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Pancakes' }),
  })
  expect(response.status).toBe(201)
  await expect(response.json()).resolves.toEqual({ recipe: { id: 'recipe-2', title: 'Pancakes' } })
})

test('service authentication rejects a token signed by an untrusted key', async () => {
  const { token } = await createAccessToken({
    claims: { common_name: 'smoke-client.access', sub: '' },
  })
  const { publicJwk } = await createAccessToken()
  mockCloudflareJwks(publicJwk)
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: { ...productionEnv, CLOUDFLARE_SMOKE_CLIENT_ID: 'smoke-client.access' },
  })

  const response = await testApp.request('/recipes', {
    headers: { 'cf-access-jwt-assertion': token },
  })
  expect(response.status).toBe(401)
})

test('service credentials alone are not accepted as an origin JWT', async () => {
  const testApp = createTestApp({
    authProvider: cloudflareAuthProvider,
    env: { ...productionEnv, CLOUDFLARE_SMOKE_CLIENT_ID: 'smoke-client.access' },
  })

  const response = await testApp.request('/recipes', {
    headers: {
      'CF-Access-Client-Id': 'smoke-client.access',
      'CF-Access-Client-Secret': 'not-a-signed-jwt',
    },
  })
  expect(response.status).toBe(401)
})

test('parseAppEnv rejects production-like startup env without JWT verification config', () => {
  expect(() =>
    parseAppEnv({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://recipes.rkac.dev',
    }),
  ).toThrow(/CLOUDFLARE_ACCESS_AUD/)
})

test('OPTIONS preflight does not authenticate', async () => {
  const testApp = createTestApp({
    authProvider: unauthenticatedAuthProvider,
    env: productionEnv,
  })

  const response = await testApp.request('/recipes', {
    method: 'OPTIONS',
    headers: {
      'access-control-request-method': 'GET',
      origin: 'https://recipes.rkac.dev',
    },
  })

  expect(response.status).toBe(204)
})

test('GET /health does not authenticate', async () => {
  const testApp = createTestApp({
    authProvider: unauthenticatedAuthProvider,
    env: productionEnv,
  })

  const response = await testApp.request('/health')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true })
})

function mockCloudflareJwks(publicJwk: Awaited<ReturnType<typeof exportJWK>>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { 'content-type': 'application/json' },
      }),
  )
}

function createTestApp({
  authProvider,
  env,
  recipes = createFakeRecipes([{ id: 'starter', title: 'Starter Recipe' }]),
}: {
  authProvider: AuthProvider
  env: AppEnv
  recipes?: Recipes
}) {
  return createApp({ authProvider, env, recipes })
}

function createFakeRecipes(initialRecipes: Recipe[] = []): Recipes {
  let storedRecipes = [...initialRecipes]

  return {
    async list() {
      return storedRecipes
    },

    async create(input: CreateRecipe) {
      const recipe = {
        id: `recipe-${storedRecipes.length + 1}`,
        title: input.title,
      }
      storedRecipes = [...storedRecipes, recipe]

      return recipe
    },
  }
}
