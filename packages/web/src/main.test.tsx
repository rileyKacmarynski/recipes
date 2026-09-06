import { render, screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { App } from './App'
import { identityQueryOptions, recipesQueryOptions } from './lib/queries'
import { createAppRouter } from './router'

test('renders saved recipes', () => {
  render(
    <App
      identity={{ provider: 'local', subject: 'local@domain.com', email: 'local@domain.com' }}
      onCreateRecipe={async () => undefined}
      recipes={[{ id: 'starter', title: 'Starter Recipe' }]}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Recipes' })).toBeInTheDocument()
  expect(screen.getByText('Signed in as local@domain.com')).toBeInTheDocument()
  expect(screen.getByText('Starter Recipe')).toBeInTheDocument()
})

test('renders an empty recipe state', () => {
  render(
    <App
      identity={{ provider: 'local', subject: 'local@domain.com', email: 'local@domain.com' }}
      onCreateRecipe={async () => undefined}
      recipes={[]}
    />,
  )

  expect(screen.getByText('No recipes yet.')).toBeInTheDocument()
  expect(screen.getByText(/Add one recipe title/)).toBeInTheDocument()
})

test('submits a new recipe title', async () => {
  const user = userEvent.setup()
  const onCreateRecipe = vi.fn(async () => undefined)

  render(
    <App
      identity={{ provider: 'local', subject: 'local@domain.com', email: 'local@domain.com' }}
      onCreateRecipe={onCreateRecipe}
      recipes={[]}
    />,
  )

  await user.type(screen.getByLabelText('Recipe title'), 'Pancakes')
  await user.click(screen.getByRole('button', { name: 'Add recipe' }))

  expect(onCreateRecipe).toHaveBeenCalledWith({ title: 'Pancakes' })
  expect(screen.getByLabelText('Recipe title')).toHaveValue('')
})

test('loads recipes through route context', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(identityQueryOptions.queryKey, {
    provider: 'local',
    subject: 'local@domain.com',
    email: 'local@domain.com',
  })
  queryClient.setQueryData(recipesQueryOptions.queryKey, [
    { id: 'starter', title: 'Starter Recipe' },
  ])
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  render(<RouterProvider router={router} />)

  expect(await screen.findByText('Starter Recipe')).toBeInTheDocument()
})
