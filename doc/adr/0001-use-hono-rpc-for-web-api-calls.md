# 0001. Use Hono RPC For Web API Calls

Date: 2026-08-11

## Status

Accepted

## Context

The repository has a first-party React web app and a Hono API. The first API-backed screen needs typed calls from web to API without introducing OpenAPI generation, a separate contract package, or broad infrastructure.

The API owns endpoint request/response shapes. `packages/core` owns domain objects that are shared across packages. The recipe-builder domain is intentionally shallow for now and will be modeled later.

The web app also needs a data-loading pattern that agents can exercise end-to-end through Playwright. TanStack Router already owns route loading, and React Query provides a query cache and suspense-friendly query APIs that can be injected through route context.

## Decision

Use Hono RPC for typed first-party web-to-api calls.

- `packages/api` exports a type-only RPC contract from `@recipes/api/rpc`.
- `packages/web` imports that contract with type-only imports and builds its client in `packages/web/src/api.ts`.
- API endpoint response shapes stay in `packages/api`; domain objects stay in `packages/core`.
- TanStack Router route context carries `queryClient`.
- TanStack Router file routing owns route discovery; `packages/web/src/routeTree.gen.ts` is generated and committed.
- Route loaders prefetch React Query queries, and route components read them with `useSuspenseQuery`.
- `VITE_API_URL` can override the API base URL; local development defaults to `http://localhost:3000`.
- The API enables CORS so the Vite dev server can call the API directly during local development and Playwright runs.

## Consequences

The web package has a type-level dependency on the API package. This couples first-party clients to the Hono server contract, which is acceptable while the repo has one web app and one API.

The API package should avoid exporting runtime server code as a client-facing package surface. If the contract grows or non-web clients appear, revisit whether a generated contract or dedicated contract package is warranted.

React Query is now part of the web data-loading baseline. Future route data should prefer the route-context query client pattern before adding separate data-loading seams.
