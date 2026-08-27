import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

type CloudflareAccessConfig = {
  required: boolean;
  teamDomain?: string;
  aud?: string;
  jwks?: JWTVerifyGetKey;
};

type CloudflareAccessEnv = {
  CLOUDFLARE_ACCESS_JWT_REQUIRED?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
};

const truthy = new Set(["1", "true", "yes"]);

export function cloudflareAccessConfigFromEnv(env: CloudflareAccessEnv): CloudflareAccessConfig {
  return {
    required: truthy.has((env.CLOUDFLARE_ACCESS_JWT_REQUIRED ?? "").toLowerCase()),
    teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
    aud: env.CLOUDFLARE_ACCESS_AUD,
  };
}

function normalizeTeamDomain(teamDomain: string) {
  if (teamDomain.startsWith("http://") || teamDomain.startsWith("https://")) {
    const url = new URL(teamDomain);
    return url.host;
  }

  return teamDomain.replace(/\/+$/, "");
}

export function cloudflareAccess(config: CloudflareAccessConfig): MiddlewareHandler {
  if (!config.required) {
    return async (_c, next) => next();
  }

  const teamDomain = config.teamDomain ? normalizeTeamDomain(config.teamDomain) : undefined;
  const aud = config.aud;
  const jwks =
    config.jwks ??
    (teamDomain
      ? createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`))
      : undefined);

  return async (c, next) => {
    if (c.req.method === "OPTIONS" || c.req.path === "/health") {
      await next();
      return;
    }

    if (!teamDomain || !aud || !jwks) {
      return c.json({ error: "Cloudflare Access JWT verification is not configured" }, 500);
    }

    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) {
      return c.json({ error: "Missing Cloudflare Access JWT" }, 401);
    }

    try {
      await jwtVerify(token, jwks, {
        audience: aud,
        issuer: `https://${teamDomain}`,
      });
    } catch {
      return c.json({ error: "Invalid Cloudflare Access JWT" }, 401);
    }

    await next();
  };
}
