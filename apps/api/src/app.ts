import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Recipe } from "@recipes/shared";

const starterRecipe: Recipe = {
  id: "starter",
  title: "Starter Recipe",
};

export const app = new Hono()
  .use("*", cors())
  .get("/health", (c) => c.json({ ok: true }))
  .get("/recipes", (c) => c.json({ recipes: [starterRecipe] }));
