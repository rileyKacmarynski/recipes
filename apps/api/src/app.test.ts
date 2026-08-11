import { expect, test } from "vitest";
import { app } from "./app";

test("GET /health returns ok", async () => {
  const response = await app.request("/health");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});
