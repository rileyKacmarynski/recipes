# Agent Notes

## Shape

- All code packages live under `packages/`: `packages/web` (`@recipes/web`), `packages/api` (`@recipes/api`), `packages/core` (`@recipes/core`).
- Web entrypoint is `packages/web/src/main.tsx`; TanStack Router file routes live in `packages/web/src/routes`, and `packages/web/src/routeTree.gen.ts` is generated.
- API entrypoint is `packages/api/src/index.ts`; routes live in `packages/api/src/app.ts` and are tested with `app.request(...)`.
- `@recipes/core` exports `packages/core/src/index.ts` directly via package exports; update core domain types there before duplicating app-local types.

## Commands

- Root checks: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Formatting/linting are Oxfmt/Oxlint via root scripts; do not add Prettier config or `.prettierignore` files for formatter behavior.
- `pnpm format` currently also reports repo-local `.agents` Markdown plus generated/shadcn files; format changed hand-written app files directly with `pnpm exec oxfmt <paths>` when needed.
- Focus a package with filters: `pnpm --filter @recipes/api test`, `pnpm --filter @recipes/web typecheck`, `pnpm --filter @recipes/core build`.
- Focus a Vitest file with `exec`: `pnpm --filter @recipes/api exec vitest run src/app.test.ts` or `pnpm --filter @recipes/web exec vitest run src/main.test.tsx`.
- E2E runs from the web package: `pnpm test:e2e -- recipes.spec.ts` or `pnpm test:e2e -- -g "shows recipes page"`.

## Dev Servers And Ports

- `pnpm dev` starts web and API concurrently; API defaults to `API_PORT=3000`, web defaults to `WEB_PORT=5173`.
- Playwright starts `pnpm -w dev` from `packages/web/playwright.config.ts` and uses `WEB_PORT` for `baseURL`.
- In parallel worktrees, pass ports inline instead of adding scripts or env files: `WEB_PORT=6174 API_PORT=3001 pnpm dev` and `WEB_PORT=6174 API_PORT=3001 pnpm test:e2e`.

## Constraints

- Keep durable architecture/product decisions in `doc/adr` as numbered Markdown ADRs.
- The README explicitly keeps auth, database/ORM, Docker, AWS/Terraform, CI/CD, hooks, AI libraries, uploads, and broad env management out until there is a concrete need.
- TypeScript owns application state and business logic; Python is only for extraction or ML tasks if those are added later.
- Do not create Git worktrees unless the user asks for one.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single root domain context and repo ADRs in `doc/adr`. See `docs/agents/domain.md`.

### Preference skills

- Use `.agents/skills/architecture-preferences/SKILL.md` when designing or implementing application/domain code; it captures the repo preference for DDD vocabulary, Zod schemas at boundaries, and schema-first functional-core implementation.
- Use `.agents/skills/frontend-ui-preferences/SKILL.md` when designing or implementing UI; it captures the repo preference for simple, clean, intentional interfaces.
- Use `.agents/skills/accessibility-quality/SKILL.md` when creating or reviewing frontend interaction, semantics, forms, focus, keyboard behavior, or visual states.
- Use `.agents/skills/testing-preferences/SKILL.md` when adding or reviewing tests; it captures the repo preference for broad meaningful units, behavior seams, Playwright as system/product confidence, and Vitest as fast regression confidence.
