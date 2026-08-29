import type { AppType } from '@recipes/api/rpc'
import type { Recipe } from '@recipes/core'
import { hc } from 'hono/client'

type IdentityContext = {
  provider: 'local' | 'cloudflare-access'
  subject: string
  email?: string
}

export type Api = {
  loadIdentity(): Promise<IdentityContext>
  loadRecipes(): Promise<Recipe[]>
}

const client = hc<AppType>(import.meta.env.VITE_API_URL ?? 'http://localhost:3000', {
  fetch: ((input, init) =>
    fetch(input, { ...init, credentials: 'include' })) satisfies typeof fetch,
})

export async function loadRecipes() {
  const response = await client.recipes.$get()

  if (!response.ok) {
    throw new Error('Failed to load recipes')
  }

  const data = await response.json()
  return data.recipes
}

export async function loadIdentity() {
  const response = await client.me.$get()

  if (!response.ok) {
    throw new Error('Failed to authenticate')
  }

  const data = await response.json()
  return data.identity
}

export const api: Api = { loadIdentity, loadRecipes }
