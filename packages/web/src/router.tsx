import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { RouteContext } from "./route-context";
import { routeTree } from "./routeTree.gen";

type CreateAppRouterOptions = RouteContext & {
  history?: RouterHistory;
};

export function createAppRouter({ queryClient, history }: CreateAppRouterOptions) {
  return createRouter({
    routeTree,
    context: { queryClient },
    history,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
