import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { App } from '../App'
import { createRecipe, recipesQueryKey, recipesQueryOptions } from '../lib/queries'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.prefetchQuery(recipesQueryOptions),
  component: RouteComponent,
})

function RouteComponent() {
  const { identity } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const { data: recipes } = useSuspenseQuery(recipesQueryOptions)
  const createRecipeMutation = useMutation({
    mutationFn: createRecipe,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: recipesQueryKey })
    },
  })

  return (
    <App
      createError={createRecipeMutation.error?.message}
      identity={identity}
      isCreating={createRecipeMutation.isPending}
      onCreateRecipe={(input) => createRecipeMutation.mutateAsync(input)}
      recipes={recipes}
    />
  )
}
