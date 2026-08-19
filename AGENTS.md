<!-- BEGIN swamp managed section - DO NOT EDIT -->
# Project

This repository is managed with [swamp](https://github.com/swamp-club/swamp).

## Rules

1. **Search before you build.** When automating AWS, APIs, or any external service: (a) search community extensions with `swamp extension search <query>` — prefer `@swamp/*` official extensions first, (b) search local/installed types with `swamp model type search <query>`, (c) if a community extension exists, install it with `swamp extension pull <package>` instead of building from scratch, (d) extend an existing type if it covers the domain but lacks the method you need, (e) only create a custom extension model in `extensions/models/` as a last resort. Read `.agents/skills/swamp/SKILL.md` for guidance. The `command/shell` model is ONLY for ad-hoc one-off shell commands, NEVER for wrapping CLI tools or building integrations.
2. **Extend, don't be clever.** When a model covers the domain but lacks the method you need, extend it with `export const extension` — don't bypass it with shell scripts, CLI tools, or multi-step hacks. One method, one purpose. Use `swamp model type describe <type> --json` to check available methods.
3. **Use the data model.** Once data exists in a model (via `lookup`, `start`, `sync`, etc.), reference it with CEL expressions. Don't re-fetch data that's already available.
4. **CEL expressions everywhere.** Wire models together with CEL expressions. Always prefer `data.latest("<name>", "<dataName>").attributes.<field>` over the deprecated `model.<name>.resource.<spec>.<instance>.attributes.<field>` pattern.
5. **Verify before destructive operations.** Always `swamp model get <name> --json` and verify resource IDs before running delete/stop/destroy methods.
6. **Prefer fan-out methods over loops.** When operating on multiple targets, use a single method that handles all targets internally (factory pattern) rather than looping N separate `swamp model method run` calls against the same model. Multiple parallel calls against the same model contend on the per-model lock, causing timeouts. A single fan-out method acquires the lock once and produces all outputs in one execution. Check `swamp model type describe` for methods that accept filters or produce multiple outputs.
7. **Extension npm deps are bundled, not lockfile-tracked.** Swamp's bundler inlines all npm packages (except zod) into extension bundles at bundle time. `deno.lock` and `package.json` do NOT cover extension model dependencies — this is by design. Always pin explicit versions in `npm:` import specifiers (e.g., `npm:lodash-es@4.17.21`).
8. **Reports for reusable data pipelines.** When the task involves building a repeatable pipeline to transform, aggregate, or analyze model output (security reports, cost analysis, compliance checks, summaries), create a report extension. Read `.agents/skills/swamp/SKILL.md` for guidance.
9. **"Workflow" means a swamp workflow.** In this repository the word "workflow" (and "create/run/execute/validate/debug workflow", "automate", "orchestrate", "automated/nightly job") refers to a swamp workflow — a declarative YAML DAG of model-method steps authored via `swamp workflow create`. Read `.agents/skills/swamp/SKILL.md` for these requests. Do NOT interpret these as a request to build an agent task list, spin up worktrees, or schedule a cron/remote agent. Only use those orchestration mechanisms when the user explicitly names one (e.g. "task list", "subagent", "worktree", "cron", "remote agent") or explicitly asks you to do the work yourself step by step rather than author a swamp workflow.
10. **Use swamp, don't bypass it.** Always work through swamp commands — don't go around them with raw shell tools. Use `swamp data query` to find data, not `grep`/`find` on `.swamp/` files. Use model methods to interact with resources, not `curl`/`aws`/`gcloud`/`kubectl` when a model type already wraps that API — check with `swamp model type search`. Use `swamp help` for CLI discovery, not guesswork. Composing with swamp output is fine (e.g. piping `--json` through `jq`) — the anti-pattern is bypassing swamp entirely.
11. **Inspect reports after failures.** When a model method or workflow run fails, inspect its generated reports before retrying or changing definitions. Reports run even on failure and capture structured diagnostics — error messages, execution status, arguments, and data output pointers. Use `swamp report get @swamp/method-summary --model <model> --json` for method failures or `swamp report get @swamp/workflow-summary --workflow <workflow> --json` for workflow failures. Run `swamp help report get` to confirm current retrieval syntax.

## Skills

**IMPORTANT:** Skills are detailed guides stored in `.agents/skills/`. When a task
matches a skill area below, read the corresponding `SKILL.md` file for guidance.

- `.agents/skills/swamp/SKILL.md` - Swamp CLI — models, workflows, data, vaults, extensions, publishing, repos, reports, issues, and troubleshooting
- `.agents/skills/swamp-getting-started/SKILL.md` - Interactive onboarding for new swamp users

## Getting Started

**IMPORTANT:** At the start of every conversation, run
`swamp model search --json`. If no models are returned (empty result), you MUST
immediately read `.agents/skills/swamp-getting-started/SKILL.md` and follow its
instructions. This walks new users through an interactive onboarding tutorial.

If models already exist, start by reading `.agents/skills/swamp/SKILL.md`
to work with swamp models.

## Commands

Use `swamp --help` to see available commands. For a machine-readable JSON
schema of the CLI (commands, options, arguments) intended for agent
consumption, run `swamp help [<command>...]` — e.g. `swamp help` returns
the full tree, and `swamp help model method run` scopes to a subtree.
<!-- END swamp managed section -->

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
