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

### Local built-artifact acceptance (UAT)

Requires Node 24+, pnpm dependencies, Docker Desktop/OrbStack (`docker info`), and
Playwright Chromium (`pnpm --filter @recipes/uat exec playwright install chromium`).
Run from the repository root:

```sh
# Producer: choose a NEW directory for each handoff (existing paths are refused).
pnpm build:uat .local/uat/artifacts/my-build

# Verifier: consumes that exact handoff; does not build or repair anything.
pnpm uat .local/uat/artifacts/my-build
# Optional NEW evidence directory:
pnpm uat .local/uat/artifacts/my-build .local/uat/runs/my-verification
```

The handoff is portable between compatible local Node environments: `web/`,
`api.cjs`, `migrate.cjs`, `migrations/`, and `manifest.json`. Node executables bundle
their dependencies; no application source execution or watch/dev servers are used.
The manifest hashes every supplied file; reports identify the complete file set by
SHA-256. Checksums detect accidental changes, not the authenticity of untrusted code:
only run artifacts you trust. With no output argument, `build:uat` writes to the new
`.local/uat/artifacts` directory.

Each verification provisions fresh disposable Postgres, applies the supplied real
migrations, starts the built API and a static frontend server on ephemeral ports,
and uses the existing local identity. Browser scenarios cover empty state,
create/list, persistence after reload, and empty/whitespace-title rejection. They
use real HTTP requests; there are no API interceptions or internal assertions.
`DATABASE_URL` and cloud/auth settings from your shell are not passed to the app.
Repeated runs do not reuse data, containers, or existing servers.

Evidence defaults to `.local/uat/runs/<timestamp>-<pid>/` and survives teardown:

- `summary.txt` and `report.json`: artifact manifest/hash, `passed`, `setup-error`,
  or `expectation-failed`, scenario results, runtime resource identifiers, cleanup,
  timestamps, and evidence location.
- `api.log`, `frontend.log`, `migrations.log`, `postgres.log`, `playwright.log`.
- `playwright.json`, `html/` browser report, and `browser/` failure screenshots/traces.
  Open the report with `pnpm --filter @recipes/uat exec playwright show-report <absolute-path-to-html>`.

Every scenario must pass for exit zero. Setup errors and expectation failures exit
one. SIGINT/SIGTERM trigger owned process-group/container cleanup and a setup-error
report; as with any process, SIGKILL or a host crash cannot run teardown (Testcontainers
also provides its resource reaper). Evidence paths must be new and separate from
the artifact directory. Startup failures may have no browser report, but retain the
summary and logs produced before failure. Preserve both the handoff and evidence
when reporting a failure; verification must not edit code, scenarios, or expectations
to make it pass.

Runner regression tests do not require Docker by default. To validate repeated
clean runs, broken supplied migration SQL, API startup failure, assertion evidence,
interruption, and resource cleanup against an existing handoff:

```sh
UAT_TEST_ARTIFACTS="$PWD/.local/uat/artifacts/my-build" pnpm --filter @recipes/uat test
```

These checks make isolated copies of the handoff for failure fixtures and retain
their evidence under `.local/uat/checks/`. They never change the supplied handoff or
the acceptance contract. See [ADR 0007](doc/adr/0007-separate-local-artifact-production-from-black-box-acceptance.md).
Production credentials, deployment/CI gates, and agent orchestration are outside
this local workflow.

### Local agent reviews and bounded feedback

`pnpm loop <approved-run-config.json>` adds independent code/security reviews,
optional architecture review, artifact UAT, and an acceptance verifier. Use
`mode: "verify"` after implementing collaboratively: no implementation agent, source
edits, or automatic repairs. `mode: "implement"` permits bounded repairs through an
explicit source-file authorization. Both modes end with evidence for human approval.
Models are configurable per role. The default uses ChatGPT OAuth with token budgets;
paid API/provider fallback is rejected, and subscription dollars are reported as unpriced.
See [the local loop guide](docs/local-loop.md) for macOS isolation, OpenCode/provider
prerequisites, explicit contract/config inputs, limits and opt-in exercises.

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
anything. See the [plan-preview runbook](doc/production-infra-workflow.md#local-preview-and-inspection)
for var-file inputs, report locations, and secret-handling limits.

After a local preview, no paths are needed:

```sh
pnpm infra:inspect  # Redacted inspection of the newest local saved plan
pnpm infra:review   # Full private terminal review of that local plan
```

Review infrastructure changes locally or in the PR before pushing/merging to
`main`. Actions then builds, saves/inspects a fresh Terraform plan and applies that
exact file automatically in the same job—no manual Actions approval, plan transfer
or extra encryption keys. See the [production workflow runbook](doc/production-infra-workflow.md).
The revised workflow still needs a live validation run. Pipeline monitoring (#28)
remains separate from local built-artifact black-box UAT (#24).

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
