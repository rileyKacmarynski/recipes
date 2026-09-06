import { expect, test } from '@playwright/test'

test('shows empty state and creates a recipe', async ({ page }) => {
  const recipes: Array<{ id: string; title: string }> = []

  await page.route('**/me', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        identity: {
          provider: 'local',
          subject: 'local@domain.com',
          email: 'local@domain.com',
        },
      },
    })
  })

  await page.route('**/recipes', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { title: string }
      const recipe = { id: `recipe-${recipes.length + 1}`, title: body.title.trim() }
      recipes.push(recipe)

      await route.fulfill({ contentType: 'application/json', json: { recipe }, status: 201 })
      return
    }

    await route.fulfill({ contentType: 'application/json', json: { recipes } })
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { exact: true, name: 'Recipes' })).toBeVisible()
  await expect(page.getByText('No recipes yet.')).toBeVisible()

  await page.getByLabel('Recipe title').fill('Pancakes')
  await page.getByRole('button', { name: 'Add recipe' }).click()

  await expect(page.getByText('Pancakes')).toBeVisible()
  await expect(page.getByText('1 recipe')).toBeVisible()
})
