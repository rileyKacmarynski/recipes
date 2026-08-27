import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, test } from "vitest";
import { app, createApp } from "./app";

async function createAccessToken(overrides: { aud?: string; issuer?: string } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";

  const token = await new SignJWT({ email: "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.issuer ?? "https://team.cloudflareaccess.com")
    .setAudience(overrides.aud ?? "expected-aud")
    .setExpirationTime("1h")
    .sign(privateKey);

  return {
    token,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  };
}

test("GET /health returns ok", async () => {
  const response = await app.request("/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

test("GET /recipes returns recipes", async () => {
  const testApp = createApp({ access: { required: false } });

  const response = await testApp.request("/recipes");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    recipes: [{ id: "starter", title: "Starter Recipe" }],
  });
});

test("GET /recipes allows requests when Cloudflare Access JWT verification is disabled", async () => {
  const testApp = createApp({ access: { required: false } });

  const response = await testApp.request("/recipes");

  expect(response.status).toBe(200);
});

test("GET /recipes requires Cloudflare Access configuration by default", async () => {
  const testApp = createApp({ env: {} });

  const response = await testApp.request("/recipes");

  expect(response.status).toBe(500);
  await expect(response.json()).resolves.toEqual({
    error: "Cloudflare Access JWT verification is not configured",
  });
});

test("GET /recipes reproduces the initial API fetch failure before the API Access JWT is available", async () => {
  const { jwks } = await createAccessToken();
  const testApp = createApp({
    access: { required: true, teamDomain: "team.cloudflareaccess.com", aud: "expected-aud", jwks },
    env: { WEB_ORIGIN: "https://recipes.rkac.dev" },
  });

  const response = await testApp.request("/recipes", {
    headers: {
      origin: "https://recipes.rkac.dev",
      referer: "https://recipes.rkac.dev/",
    },
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "Missing Cloudflare Access JWT" });
});

test("GET /recipes rejects missing Cloudflare Access JWTs when verification is required", async () => {
  const { jwks } = await createAccessToken();
  const testApp = createApp({
    access: { required: true, teamDomain: "team.cloudflareaccess.com", aud: "expected-aud", jwks },
  });

  const response = await testApp.request("/recipes");

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "Missing Cloudflare Access JWT" });
});

test("GET /recipes rejects invalid Cloudflare Access JWTs", async () => {
  const { token, jwks } = await createAccessToken({ aud: "wrong-aud" });
  const testApp = createApp({
    access: { required: true, teamDomain: "team.cloudflareaccess.com", aud: "expected-aud", jwks },
  });

  const response = await testApp.request("/recipes", {
    headers: { "cf-access-jwt-assertion": token },
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "Invalid Cloudflare Access JWT" });
});

test("GET /recipes accepts valid Cloudflare Access JWTs", async () => {
  const { token, jwks } = await createAccessToken();
  const testApp = createApp({
    access: { required: true, teamDomain: "team.cloudflareaccess.com", aud: "expected-aud", jwks },
  });

  const response = await testApp.request("/recipes", {
    headers: { "cf-access-jwt-assertion": token },
  });

  expect(response.status).toBe(200);
});

test("OPTIONS preflight does not require a Cloudflare Access JWT", async () => {
  const { jwks } = await createAccessToken();
  const testApp = createApp({
    access: { required: true, teamDomain: "team.cloudflareaccess.com", aud: "expected-aud", jwks },
    env: { WEB_ORIGIN: "https://recipes.rkac.dev" },
  });

  const response = await testApp.request("/recipes", {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "GET",
      origin: "https://recipes.rkac.dev",
    },
  });

  expect(response.status).toBe(204);
});

test("GET /health does not require a Cloudflare Access JWT", async () => {
  const { jwks } = await createAccessToken();
  const testApp = createApp({
    access: { required: true, teamDomain: "team.cloudflareaccess.com", aud: "expected-aud", jwks },
  });

  const response = await testApp.request("/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});
