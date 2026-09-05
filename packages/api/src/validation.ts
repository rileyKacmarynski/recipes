import { zValidator as honoZValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'

export function zValidator<TSchema extends z.ZodSchema, TTarget extends keyof ValidationTargets>(
  target: TTarget,
  schema: TSchema,
) {
  return honoZValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error.issues[0]?.message ?? 'Invalid request' }, 400)
    }
  })
}
