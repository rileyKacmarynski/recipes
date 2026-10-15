import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { recipes as recipesTable } from '@recipes/db'
import type { createTestDatabase } from '@recipes/db/testing'
import { createRecipeSchema, createRecipes, type Recipes } from './index'

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

  test('lists no recipes in a fresh database', async () => {
    await expect(recipes.list()).resolves.toEqual([])
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
