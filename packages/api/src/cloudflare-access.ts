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

function logAccessDecision(
  level: "info" | "warn" | "error",
  decision: string,
  details: Record<string, string | boolean | undefined>,
) {
  console[level](
    JSON.stringify({
      event: "cloudflare_access_jwt",
      decision,
      ...details,
    }),
  );
}

function requestDiagnostics(c: Parameters<MiddlewareHandler>[0]) {
  return {
    method: c.req.method,
    path: c.req.path,
    host: c.req.header("host"),
    origin: c.req.header("origin"),
    referer: c.req.header("referer"),
    userAgent: c.req.header("user-agent"),
    cfRay: c.req.header("cf-ray"),
    forwardedFor: c.req.header("x-forwarded-for"),
    traceId: c.req.header("x-amzn-trace-id"),
    hasAccessJwt: Boolean(c.req.header("cf-access-jwt-assertion")),
    hasAccessUser: Boolean(c.req.header("cf-access-authenticated-user-email")),
  };
}

export function cloudflareAccessConfigFromEnv(env: CloudflareAccessEnv): CloudflareAccessConfig {
  return {
    required: env.CLOUDFLARE_ACCESS_JWT_REQUIRED !== "false",
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
      logAccessDecision("info", "skipped", {
        ...requestDiagnostics(c),
        reason: c.req.method === "OPTIONS" ? "preflight" : "health_check",
      });
      await next();
      return;
    }

    if (!teamDomain || !aud || !jwks) {
      logAccessDecision("error", "misconfigured", {
        ...requestDiagnostics(c),
        hasTeamDomain: Boolean(teamDomain),
        hasAud: Boolean(aud),
        hasJwks: Boolean(jwks),
      });
      return c.json({ error: "Cloudflare Access JWT verification is not configured" }, 500);
    }

    const token = c.req.header("cf-access-jwt-assertion");
    if (!token) {
      logAccessDecision("warn", "missing_token", {
        ...requestDiagnostics(c),
      });
      return c.json({ error: "Missing Cloudflare Access JWT" }, 401);
    }

    try {
      const result = await jwtVerify(token, jwks, {
        audience: aud,
        issuer: `https://${teamDomain}`,
      });
      logAccessDecision("info", "accepted", {
        ...requestDiagnostics(c),
        issuer: typeof result.payload.iss === "string" ? result.payload.iss : undefined,
        audienceMatched: true,
      });
    } catch (error) {
      logAccessDecision("warn", "invalid_token", {
        ...requestDiagnostics(c),
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return c.json({ error: "Invalid Cloudflare Access JWT" }, 401);
    }

    await next();
  };
}
