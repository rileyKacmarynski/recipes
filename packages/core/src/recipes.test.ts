import { eq } from 'drizzle-orm'
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
  const testTitle = `Pancakes ${crypto.randomUUID()}`

  afterAll(async () => {
    await db.delete(recipesTable).where(eq(recipesTable.title, testTitle))
    await db.$client.end()
  })

  beforeEach(async () => {
    await db.delete(recipesTable).where(eq(recipesTable.title, testTitle))
  })

  test('creates and lists recipes', async () => {
    const created = await recipes.create(createRecipeSchema.parse({ title: `  ${testTitle}  ` }))

    expect(created).toEqual({
      id: expect.any(String),
      title: testTitle,
    })

    await expect(recipes.list()).resolves.toContainEqual(created)
  })
})
