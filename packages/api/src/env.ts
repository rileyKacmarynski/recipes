import { z } from 'zod'

const envSchema = z
  .looseObject({
    CLOUDFLARE_ACCESS_AUD: z.string().min(1).optional(),
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
    DATABASE_DRIVER: z.enum(['postgres', 'data-api']).optional(),
    DATABASE_NAME: z.string().min(1).optional(),
    DATABASE_RESOURCE_ARN: z.string().min(1).optional(),
    DATABASE_SECRET_ARN: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    NODE_ENV: z.string().min(1),
    WEB_ORIGIN: z.string().min(1),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'development') {
      if (!env.CLOUDFLARE_ACCESS_AUD) {
        ctx.addIssue({
          code: 'custom',
          path: ['CLOUDFLARE_ACCESS_AUD'],
          message: 'Required outside development',
        })
      }

      if (!env.CLOUDFLARE_ACCESS_TEAM_DOMAIN) {
        ctx.addIssue({
          code: 'custom',
          path: ['CLOUDFLARE_ACCESS_TEAM_DOMAIN'],
          message: 'Required outside development',
        })
      }
    }
  })

export type AppEnv = z.infer<typeof envSchema>

export function parseAppEnv(env: NodeJS.ProcessEnv): AppEnv {
  return envSchema.parse(env)
}
