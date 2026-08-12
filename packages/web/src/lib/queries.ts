import { queryOptions } from "@tanstack/react-query";
import { loadRecipes } from "../api";

export const recipesQueryKey = ["recipes"] as const;

export const recipesQueryOptions = queryOptions({
  queryKey: recipesQueryKey,
  queryFn: loadRecipes,
});
