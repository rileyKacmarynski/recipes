import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Recipe } from "@recipes/core";

const starterRecipe: Recipe = {
  id: "starter",
  title: "Starter Recipe",
};

export const app = new Hono()
  .use(
    "*",
    cors({
      origin: (origin) => {
        if (origin === "https://recipes.rkac.dev" || origin.startsWith("http://localhost:")) {
          return origin;
        }

        return null;
      },
      credentials: true,
    }),
  )
  .get("/health", (c) => c.json({ ok: true }))
  .get("/recipes", (c) => c.json({ recipes: [starterRecipe] }));
