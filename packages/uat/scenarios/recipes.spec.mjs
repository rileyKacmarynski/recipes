import { test, expect } from '@playwright/test'

test.describe.serial('Recipe acceptance contract', () => {
  test('fresh application shows an empty recipe state', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Recipes', exact: true })).toBeVisible()
    await expect(page.getByText('No recipes yet.', { exact: true })).toBeVisible()
    await expect(page.getByText('0 recipes', { exact: true })).toBeVisible()
  })

  test('create a recipe and see it listed', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Recipe title').fill('UAT pancakes')
    await page.getByRole('button', { name: 'Add recipe' }).click()
    await expect(page.getByRole('listitem')).toHaveText(['UAT pancakes'])
    await expect(page.getByText('1 recipe', { exact: true })).toBeVisible()
  })

  test('recipe remains visible after reload', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('listitem')).toHaveText(['UAT pancakes'])
    await page.reload()
    await expect(page.getByRole('listitem')).toHaveText(['UAT pancakes'])
  })

  test('reject an empty title without creating a recipe', async ({ page }) => {
    await page.goto('/')
    const title = page.getByLabel('Recipe title')
    await title.fill('')
    await page.getByRole('button', { name: 'Add recipe' }).click()
    await expect(title).toBeFocused()
    await expect(title).toHaveAttribute('required', '')
    // Whitespace reaches the real HTTP API and exercises server-side validation too.
    await title.fill('   ')
    await page.getByRole('button', { name: 'Add recipe' }).click()
    await expect(page.getByRole('alert')).toHaveText('Failed to create recipe')
    await page.reload()
    await expect(page.getByRole('listitem')).toHaveText(['UAT pancakes'])
    await expect(page.getByText('1 recipe', { exact: true })).toBeVisible()
  })
})
