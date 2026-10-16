# Add cost-sensitive PostgreSQL persistence with Aurora Serverless and Drizzle

We will add persistence with Aurora PostgreSQL-compatible Serverless v2, Drizzle ORM, and a `packages/db` package that owns the Drizzle schema, migrations, client factories, and initial recipe queries. Production access will use RDS Data API so the Lambda API does not need VPC networking, with DB credentials stored in the required AWS Secrets Manager secret and non-secret configuration flowing through GitHub/Terraform outputs rather than runtime parameter lookups. This fits a cost-sensitive solo project while preserving a path to separate per-environment databases later.

Aurora will live in a dedicated minimal Terraform-owned VPC with no NAT and no public database access. The initial tracer bullet will use a minimal `recipes` table with app-generated UUIDs, `title`, `createdAt`, and `updatedAt`, plus `GET /recipes` and `POST /recipes` behavior through the existing Hono API and React SPA. Local development will use Docker Compose Postgres with the same Drizzle schema and migration files but a normal Postgres driver; production Lambda will use a separate Data API client factory.

Migrations are forward-only and non-breaking by default unless we explicitly accept breakage. The production deploy pipeline will apply Terraform, read outputs, run Drizzle migration checks, run prod migrations, and fail the deploy before API/web rollout if migration fails. Runtime API config will use explicit env vars including `DATABASE_DRIVER=data-api`, `DATABASE_NAME`, `DATABASE_SECRET_ARN`, and `DATABASE_RESOURCE_ARN`; local scripts will use `DATABASE_DRIVER=postgres` and `DATABASE_URL`.

## Verification refinements

Core and API persistence tests use migrated disposable Postgres containers, not
the shared development database. They are opt-in with `RUN_DB_TESTS=1`; ordinary
Vitest runs remain Docker-free. This tests real Postgres behavior without claiming
Aurora Data API parity. Current Playwright coverage uses intercepted API responses;
full built-artifact black-box UAT is separate work under issue #24.

ADR 0004 adds a read-only production smoke test through the authenticated public
API to verify the deployed Data API-backed recipe read without seed data or writes.
