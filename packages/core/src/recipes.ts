import { asc } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { InsertRecipe, RecipeRow, RecipesDatabase } from '@recipes/db'
import { recipes as recipesTable } from '@recipes/db'

export const recipeSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1, { error: 'Recipe title is required' }),
})

export const createRecipeSchema = recipeSchema.pick({ title: true })

export type Recipe = z.infer<typeof recipeSchema>
export type CreateRecipe = z.infer<typeof createRecipeSchema>
export type Recipes = ReturnType<typeof createRecipes>

export function createRecipes(db: RecipesDatabase) {
  return {
    async list() {
      const rows = await db
        .select()
        .from(recipesTable)
        .orderBy(asc(recipesTable.createdAt), asc(recipesTable.id))

      return rows.map(toRecipe)
    },

    async create(input: CreateRecipe) {
      const now = new Date()
      const insert = {
        id: randomUUID(),
        title: input.title,
        createdAt: now,
        updatedAt: now,
      } satisfies InsertRecipe

      const [created] = await db.insert(recipesTable).values(insert).returning()

      return toRecipe(created)
    },
  }
}

function toRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    title: row.title,
  }
}
