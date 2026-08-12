# Agent Notes

## Shape

- pnpm workspace: `apps/web` (`@recipes/web`), `apps/api` (`@recipes/api`), `packages/shared` (`@recipes/shared`).
- Web entrypoint is `apps/web/src/main.tsx`; TanStack Router file routes live in `apps/web/src/routes`, and `apps/web/src/routeTree.gen.ts` is generated.
- API entrypoint is `apps/api/src/index.ts`; routes live in `apps/api/src/app.ts` and are tested with `app.request(...)`.
- `@recipes/shared` exports `packages/shared/src/index.ts` directly via package exports; update shared types there before duplicating app-local types.

## Commands

- Root checks: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Formatting/linting are Oxfmt/Oxlint via root scripts; do not add Prettier config or `.prettierignore` files for formatter behavior.
- Focus a package with filters: `pnpm --filter @recipes/api test`, `pnpm --filter @recipes/web typecheck`, `pnpm --filter @recipes/shared build`.
- Focus a Vitest file with `exec`: `pnpm --filter @recipes/api exec vitest run src/app.test.ts` or `pnpm --filter @recipes/web exec vitest run src/main.test.tsx`.
- E2E runs from the web package: `pnpm test:e2e -- recipes.spec.ts` or `pnpm test:e2e -- -g "shows recipes page"`.

## Dev Servers And Ports

- `pnpm dev` starts web and API concurrently; API defaults to `API_PORT=3000`, web defaults to `WEB_PORT=5173`.
- Playwright starts `pnpm -w dev` from `apps/web/playwright.config.ts` and uses `WEB_PORT` for `baseURL`.
- In parallel worktrees, pass ports inline instead of adding scripts or env files: `WEB_PORT=6174 API_PORT=3001 pnpm dev` and `WEB_PORT=6174 API_PORT=3001 pnpm test:e2e`.

## Constraints

- Keep durable architecture/product decisions in `doc/adr` as numbered Markdown ADRs.
- The README explicitly keeps auth, database/ORM, Docker, AWS/Terraform, CI/CD, hooks, AI libraries, uploads, and broad env management out until there is a concrete need.
- TypeScript owns application state and business logic; Python is only for extraction or ML tasks if those are added later.
- Do not create Git worktrees unless the user asks for one.
