# Recipes

A full-stack recipe application foundation.

This repository is intentionally small and feature-light. Keep changes focused, prefer simple composition, and avoid adding infrastructure before it is needed.

## Stack

- React SPA in `packages/web`
- Hono API in `packages/api`
- Core domain TypeScript package in `packages/core`
- Drizzle/Postgres persistence in `packages/db`, with Aurora Data API in production
- pnpm workspaces
- TypeScript with `strict: true`
- Oxlint and Oxfmt
- Vitest
- Playwright for frontend E2E tests

## Repository Structure

```text
packages/
  web/      React + Vite frontend
  api/      Hono API
  core/     Core domain types and utilities
  db/       Schema, migrations, database clients, and test database helpers
infra/      Production AWS/Cloudflare Terraform
doc/
  adr/      Architecture Decision Records
```

## Commands

Run these from the repository root.

```sh
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm format
pnpm typecheck
```

Local database helpers:

```sh
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:introspect
pnpm db:studio
pnpm db:down
```

Frontend E2E helpers:

```sh
pnpm test:e2e
pnpm test:e2e:headed
pnpm test:e2e:ui
```

### Database-backed tests

`pnpm test` and `pnpm test:unit` skip database-backed suites by default and do not
require Docker. To include the real Postgres recipe and API behavior tests, start
Docker Desktop or OrbStack (check that `docker info` succeeds), then run:

```sh
RUN_DB_TESTS=1 pnpm --filter @recipes/core test
RUN_DB_TESTS=1 pnpm --filter @recipes/api test
# Or run all packages, including their DB-backed suites:
RUN_DB_TESTS=1 pnpm test
```

Each DB-backed test file starts its own disposable `postgres:18.1-alpine`
Testcontainers container on a random host port and applies the checked-in Drizzle
migrations before assertions. These tests ignore `DATABASE_URL` and do not need
`pnpm db:up` or a manually migrated development database. Data is reset between
tests; connections and containers are closed after the suite, including migration
failures. The first run needs network access to pull the container images and can
take longer. If Docker is unavailable, explicitly enabled DB tests fail rather
than silently falling back to the development database.

Playwright filters can be passed after `--`:

```sh
pnpm test:e2e -- recipes.spec.ts
pnpm test:e2e -- -g "shows recipes page"
```

## Development Notes

- `pnpm dev` starts the frontend and backend concurrently.
- Frontend dev server runs through Vite.
- API server listens on `http://localhost:3000`.
- Local Postgres listens on `localhost:5432` when started with `pnpm db:up`.
- Copy `.env.example` values into your shell or package-local env file when running DB tooling outside the default local settings.
- `GET /health` returns `{ "ok": true }`.
- The core package exports `Recipe` and is imported by both apps to verify workspace linking.

## Deployment and production smoke tests

Production uses GitHub Actions, Terraform, AWS Lambda, and Cloudflare Access.
The deployment workflow runs a direct-Lambda `/health` smoke test and the
authenticated DB-backed API smoke test:

```sh
pnpm --filter @recipes/api test:smoke
```

The latter requires a deployed HTTPS `API_URL` and service credentials; it does
not build, deploy, or write recipe data and is not included in `pnpm test`.
See the [Terraform operator guide](infra/terraform/README.md) for provisioning,
credentials, and rotation, and [ADR 0004](doc/adr/0004-use-read-only-service-auth-for-production-smoke-tests.md)
for the read-only service-identity boundary. #22's production smoke checks were
deployed and verified before the saved-plan workflow change.

For a human-run local Terraform preview with hidden credential entry and an
agent-readable sanitized report, run `bash scripts/plan-prod.sh`. It does not apply
anything. See the [plan-preview runbook](doc/production-infra-workflow.md#local-preview-details)
for var-file inputs, report locations, and secret-handling limits.

After a local preview, no paths are needed:

```sh
pnpm infra:inspect  # Redacted inspection of the newest local saved plan
pnpm infra:review   # Full private terminal review of that local plan
```

Actions plans are reviewed and approved in GitHub, not on your local machine.

Production deployment now separates the authoritative Actions saved plan from a
required human environment approval and exact-plan apply. Before enabling it,
complete the [environment, read-only planning credentials and encryption prerequisites](doc/production-infra-workflow.md#one-time-operator-prerequisites).
The new workflow still needs a live approved validation run. Pipeline monitoring
(#28) and built-artifact black-box UAT (#24) remain separate work.

## Current Scope

The application lists and creates persisted recipe titles. Local development uses
Postgres; production uses Aurora through the Data API. Cloudflare Access protects
production requests, and the API verifies signed Access JWTs.

Do not add these until there is a concrete need:

- Git hooks
- AI libraries
- File uploads
- Broad environment-variable management

## AI/Agent Guidance

Before making changes:

- Read this README and `AGENTS.md`.
- Inspect the relevant app/package before editing.
- Keep changes minimal and focused.
- Prefer existing project patterns over new abstractions.
- Run the narrowest useful verification first, then the root checks when appropriate.
- Do not implement application features while doing setup-only or tooling-only work.

When adding durable architecture or product decisions, create an ADR in `doc/adr`.
