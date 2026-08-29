import type { QueryClient } from '@tanstack/react-query'
import type { loadIdentity } from './api'

export type IdentityContext = Awaited<ReturnType<typeof loadIdentity>>

export type RouteContext = {
  queryClient: QueryClient
}
