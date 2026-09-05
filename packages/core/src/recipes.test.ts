import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { createLocalPostgresClient, recipes as recipesTable } from '@recipes/db'
import { createRecipeSchema, createRecipes } from './recipes'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://recipes:recipes@localhost:5432/recipes'
const runDbTests = process.env.RUN_DB_TESTS === '1'

describe('recipe schemas', () => {
  test('validates create recipe input', () => {
    expect(createRecipeSchema.parse({ title: '  Pancakes  ' })).toEqual({ title: 'Pancakes' })
  })

  test('rejects invalid create recipe input', () => {
    expect(() => createRecipeSchema.parse({ title: '   ' })).toThrow()
  })
})

describe.skipIf(!runDbTests)('recipes', () => {
  const db = createLocalPostgresClient(databaseUrl)
  const recipes = createRecipes(db)

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await db.delete(recipesTable)
  })

  test('creates and lists recipes', async () => {
    const created = await recipes.create(createRecipeSchema.parse({ title: '  Pancakes  ' }))

    expect(created).toEqual({
      id: expect.any(String),
      title: 'Pancakes',
    })

    await expect(recipes.list()).resolves.toEqual([created])
  })
})
