import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { App } from '../App'
import { recipesQueryOptions } from '../lib/queries'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.prefetchQuery(recipesQueryOptions),
  component: RouteComponent,
})

function RouteComponent() {
  const { identity } = Route.useRouteContext()
  const { data: recipes } = useSuspenseQuery(recipesQueryOptions)

  return <App identity={identity} recipes={recipes} />
}
