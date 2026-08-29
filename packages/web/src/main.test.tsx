import { render, screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router'
import { App } from './App'
import { identityQueryOptions, recipesQueryOptions } from './lib/queries'
import { createAppRouter } from './router'

test('renders the recipes page', () => {
  render(
    <App
      identity={{ provider: 'local', subject: 'local@domain.com', email: 'local@domain.com' }}
      recipes={[{ id: 'starter', title: 'Starter Recipe' }]}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Recipes' })).toBeInTheDocument()
  expect(screen.getByText('Signed in as local@domain.com')).toBeInTheDocument()
  expect(screen.getByText('Starter Recipe')).toBeInTheDocument()
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
