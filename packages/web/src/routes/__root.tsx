import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/router-devtools'
import type { RouteContext } from '../route-context'

export const Route = createRootRouteWithContext<RouteContext>()({
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
