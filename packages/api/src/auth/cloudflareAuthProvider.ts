import { createRemoteJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'
import type { AuthProvider } from './auth'

const serviceClaimsSchema = z.object({
  common_name: z.string().min(1),
  sub: z.literal('').optional(),
})
const userClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
})

export const cloudflareAuthProvider: AuthProvider = async (c, env) => {
  const token = c.req.header('cf-access-jwt-assertion')
  if (!token) {
    return null
  }

  if (!env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || !env.CLOUDFLARE_ACCESS_AUD) {
    throw new Error('Cloudflare Access JWT verification is not configured')
  }

  const teamDomain =
    env.CLOUDFLARE_ACCESS_TEAM_DOMAIN.startsWith('http://') ||
    env.CLOUDFLARE_ACCESS_TEAM_DOMAIN.startsWith('https://')
      ? new URL(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN).host
      : env.CLOUDFLARE_ACCESS_TEAM_DOMAIN.replace(/\/+$/, '')
  const jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))

  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: env.CLOUDFLARE_ACCESS_AUD,
      issuer: `https://${teamDomain}`,
    })

    // A service claim must never fall through to the unrestricted human identity path.
    if ('common_name' in payload) {
      const claims = serviceClaimsSchema.safeParse(payload)
      if (!claims.success || claims.data.common_name !== env.CLOUDFLARE_SMOKE_CLIENT_ID) {
        return null
      }

      return {
        provider: 'cloudflare-access-service',
        subject: claims.data.common_name,
      }
    }

    const claims = userClaimsSchema.safeParse(payload)
    return claims.success
      ? {
          provider: 'cloudflare-access',
          subject: claims.data.sub,
          email: claims.data.email,
        }
      : null
  } catch {
    console.warn('Unable to verify Cloudflare JWT.')
    return null
  }
}
