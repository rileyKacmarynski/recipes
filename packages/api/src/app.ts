import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Recipe } from "@recipes/core";
import { cloudflareAccess, cloudflareAccessConfigFromEnv } from "./cloudflare-access";

const starterRecipe: Recipe = {
  id: "starter",
  title: "Starter Recipe",
};

type AppOptions = {
  access?: Parameters<typeof cloudflareAccess>[0];
  env?: NodeJS.ProcessEnv;
};

export function createApp(options: AppOptions = {}) {
  const env = options.env ?? process.env;
  const configuredWebOrigins = (env.WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Hono()
    .use(
      "*",
      cors({
        origin: (origin) => {
          if (configuredWebOrigins.includes(origin) || origin.startsWith("http://localhost:")) {
            return origin;
          }

          return null;
        },
        credentials: true,
      }),
    )
    .use("*", cloudflareAccess(options.access ?? cloudflareAccessConfigFromEnv(env)))
    .get("/health", (c) => c.json({ ok: true }))
    .get("/recipes", (c) => c.json({ recipes: [starterRecipe] }));
}

export const app = createApp();
