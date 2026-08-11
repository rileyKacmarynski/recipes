import { expect, test } from "@playwright/test";

test("shows recipes page", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Recipes" })).toBeVisible();
});
