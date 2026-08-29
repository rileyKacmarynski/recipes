import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, expect, test, vi } from 'vitest'
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
  const testApp = createApp({
    authProvider: unauthenticatedAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/health')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({ ok: true })
})

test('GET /recipes returns recipes', async () => {
  const testApp = createApp({
    authProvider: localAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/recipes')

  expect(response.status).toBe(200)
  await expect(response.json()).resolves.toEqual({
    recipes: [{ id: 'starter', title: 'Starter Recipe' }],
  })
})

test('GET /recipes rejects requests without an identity', async () => {
  const testApp = createApp({
    authProvider: unauthenticatedAuthProvider,
    env: developmentEnv,
  })

  const response = await testApp.request('/recipes')

  expect(response.status).toBe(401)
  await expect(response.json()).resolves.toEqual({ error: 'Unauthenticated' })
})

test('GET /recipes allows local development auth provider', async () => {
  const testApp = createApp({
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
  const testApp = createApp({
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

  const testApp = createApp({
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

  const testApp = createApp({
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
  const testApp = createApp({
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
  const testApp = createApp({
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
