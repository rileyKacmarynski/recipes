import { render, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { App } from "./App";
import { recipesQueryOptions } from "./lib/queries";
import { createAppRouter } from "./router";

test("renders the recipes page", () => {
  render(<App recipes={[{ id: "starter", title: "Starter Recipe" }]} />);

  expect(screen.getByRole("heading", { name: "Recipes" })).toBeInTheDocument();
  expect(screen.getByText("Starter Recipe")).toBeInTheDocument();
});

test("loads recipes through route context", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(recipesQueryOptions.queryKey, [
    { id: "starter", title: "Starter Recipe" },
  ]);
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(<RouterProvider router={router} />);

  expect(await screen.findByText("Starter Recipe")).toBeInTheDocument();
});
