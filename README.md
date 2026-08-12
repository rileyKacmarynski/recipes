# Recipes

A full-stack recipe application foundation.

This repository is intentionally small and feature-light. Keep changes focused, prefer simple composition, and avoid adding infrastructure before it is needed.

## Stack

- React SPA in `packages/web`
- Hono API in `packages/api`
- Core domain TypeScript package in `packages/core`
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
infra/      Reserved for future infrastructure docs/config
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

Frontend E2E helpers:

```sh
pnpm test:e2e
pnpm test:e2e:headed
pnpm test:e2e:ui
```

Playwright filters can be passed after `--`:

```sh
pnpm test:e2e -- recipes.spec.ts
pnpm test:e2e -- -g "shows recipes page"
```

## Development Notes

- `pnpm dev` starts the frontend and backend concurrently.
- Frontend dev server runs through Vite.
- API server listens on `http://localhost:3000`.
- `GET /health` returns `{ "ok": true }`.
- The core package exports `Recipe` and is imported by both apps to verify workspace linking.

## Current Scope

The repository is ready for the first real feature: `GET /recipes`.

Do not add these until there is a concrete need:

- Authentication
- Database or ORM
- Docker
- AWS integrations
- Terraform
- CI/CD
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
