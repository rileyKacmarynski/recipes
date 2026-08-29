import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'
import type { RouteContext } from '../route-context'
import { identityQueryOptions } from '../lib/queries'

export const Route = createRootRouteWithContext<RouteContext>()({
  beforeLoad: async ({ context }) => {
    const identity = await context.queryClient.ensureQueryData(identityQueryOptions)

    return { identity }
  },
  component: RootComponent,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      {import.meta.env.DEV && !import.meta.env.VITEST && (
        <>
          <TanStackRouterDevtools position="bottom-right" />
          <ReactQueryDevtools position="bottom" />
        </>
      )}
    </QueryClientProvider>
  )
}
