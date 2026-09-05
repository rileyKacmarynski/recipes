import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import { z } from 'zod'

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const selectRecipeSchema = createSelectSchema(recipes)
export const insertRecipeSchema = createInsertSchema(recipes, {
  title: () => z.string().trim().min(1),
})

export type RecipeRow = z.infer<typeof selectRecipeSchema>
export type InsertRecipe = z.infer<typeof insertRecipeSchema>
