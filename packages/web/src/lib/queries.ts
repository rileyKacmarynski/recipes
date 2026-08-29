import { queryOptions } from '@tanstack/react-query'
import { loadIdentity, loadRecipes } from '../api'

export const identityQueryKey = ['identity'] as const

export const identityQueryOptions = queryOptions({
  queryKey: identityQueryKey,
  queryFn: loadIdentity,
})

export const recipesQueryKey = ['recipes'] as const

export const recipesQueryOptions = queryOptions({
  queryKey: recipesQueryKey,
  queryFn: loadRecipes,
})
