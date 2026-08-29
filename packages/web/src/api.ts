import type { AppType } from '@recipes/api/rpc'
import type { Recipe } from '@recipes/core'
import { hc } from 'hono/client'

export type Api = {
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

export const api: Api = { loadRecipes }
