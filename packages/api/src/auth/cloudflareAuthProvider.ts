import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AuthProvider } from './auth'

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

    return typeof payload.sub === 'string'
      ? {
          provider: 'cloudflare-access',
          subject: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : undefined,
        }
      : null
  } catch {
    console.warn('Unable to verify Cloudflare JWT.')
    return null
  }
}
