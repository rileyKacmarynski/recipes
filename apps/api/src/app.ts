import { Hono } from "hono";
import type { Recipe } from "@recipes/shared";

const starterRecipe: Recipe = {
  id: "starter",
  title: "Starter Recipe",
};

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", (c) => c.json({ name: "recipes-api", sampleRecipe: starterRecipe.title }));
