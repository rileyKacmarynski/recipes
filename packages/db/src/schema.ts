import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const recipes = pgTable('recipes', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})
