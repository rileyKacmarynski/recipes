import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRecipes, type CreateRecipe, type Recipe, type Recipes } from '@recipes/core'
import { createLocalPostgresClient } from '@recipes/db'
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
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://recipes:recipes@localhost:5432/recipes'
const runDbTests = process.env.RUN_DB_TESTS === '1'

afterEach(() => {
  vi.restoreAllMocks()
})

async function createAccessToken(overrides: { aud?: string; issuer?: string } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = 'test-key'

  const token = await new SignJWT({ email: 'owner@example.com', sub: 'owner-subject' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? 'https://team.cloudflareaccess.com')
    .setAudience(overrides.aud ?? 'expected-aud')
    .setExpirationTime('1h')
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
  const db = createLocalPostgresClient(databaseUrl)
  const recipes = createRecipes(db)
  const testTitle = `Pancakes ${crypto.randomUUID()}`

  afterAll(async () => {
    await db.$client`delete from recipes where title = ${testTitle}`
    await db.$client.end()
  })

  beforeEach(async () => {
    await db.$client`delete from recipes where title = ${testTitle}`
  })

  test('creates and lists recipes through the HTTP API', async () => {
    const testApp = createTestApp({
      authProvider: localAuthProvider,
      env: developmentEnv,
      recipes,
    })

    const createResponse = await testApp.request('/recipes', {
      method: 'POST',
      body: JSON.stringify({ title: `  ${testTitle}  ` }),
      headers: { 'content-type': 'application/json' },
    })

    expect(createResponse.status).toBe(201)
    const createBody = (await createResponse.json()) as { recipe: Recipe }
    expect(createBody).toEqual({
      recipe: { id: expect.any(String), title: testTitle },
    })

    const listResponse = await testApp.request('/recipes')

    expect(listResponse.status).toBe(200)
    const listBody = (await listResponse.json()) as { recipes: Recipe[] }
    expect(listBody.recipes).toContainEqual(createBody.recipe)
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
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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
