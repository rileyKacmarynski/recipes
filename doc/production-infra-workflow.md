# Production Infra Workflow

## Approval and execution

**Review changes locally or approve the PR before pushing/merging to `main`.**
There is no second manual approval inside Actions. Push/merge to `main` authorizes
the automatic deployment workflow; a manual dispatch must also select `main`.
The scripts do not attempt to prove that an offline review happened.

```text
Local preview / PR review
  → push or merge to main
  → Actions checks
  → build API → save/inspect Terraform plan → build web
  → apply that exact saved plan automatically
  → migrate DB → deploy those builds → smoke/verification checks → reports
```

The Actions plan is freshly generated for the pinned commit and current state.
It can differ from a local preview after state or merge changes. The local binary
is never uploaded or applied; approval concerns the proposed source changes, not
a claim that the local and Actions binary plans are identical.

Planning and applying run in **one job on one runner** with the existing production
credentials. The saved plan/builds never cross a job boundary. Therefore there is
no encrypted artifact handoff, extra key pair, private S3 transfer, planning role,
planning environment or custom GitHub protection-rule API check.

The workflow-wide `production-deploy` concurrency group covers checks through
verification (`cancel-in-progress: false`). Terraform operation locks are not a
reservation against separately authorized manual mutation. Coordinate operator
changes; Terraform rejects stale saved plans without an automatic replan fallback.

## Code ownership

| Piece                                     | Responsibility                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `.github/workflows/deploy.yml`            | Trigger/order, credentials, saved-plan apply, artifact deployment and reports  |
| `scripts/production-deployment.ts`        | Actions-only initialization, planning/builds, target and file-integrity checks |
| `scripts/deployment-policy.ts`            | Small pure exposure checker and redacted report                                |
| `scripts/verify-production.ts`            | Safe output handling and minimal post-deploy checks                            |
| `scripts/plan-prod.sh` / `infra-plan.mjs` | Local preview, redacted inspection and private display; never apply            |

Actions verifies the pinned checkout, Terraform/provider/configuration selections,
backend/workspace and STS account. The expected AWS account comes from the existing
`AWS_DEPLOY_ROLE_ARN`, not another repository variable. It records safe file hashes
in `manifest.json` and checks that the target, saved plan and builds are unchanged
immediately before apply. It does not rebuild or generate another plan afterward.

## Existing production configuration

Continue using the existing `production` GitHub environment and its secrets:

- `AWS_DEPLOY_ROLE_ARN`
- `TERRAFORM_STATE_BUCKET`
- `ACCESS_ALLOWED_EMAIL`
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
- `CLOUDFLARE_API_TOKEN` with the existing DNS/Access edit permissions
- `GH_OIDC_SUBJECT`, the actual configured subject, including ID-qualified formats
- `CF_ACCESS_SMOKE_CLIENT_ID`, `CF_ACCESS_SMOKE_CLIENT_SECRET`

No additional keys, role, token or environment are required for planning. An empty
`production-plan` environment auto-created by the old failed workflow is unused.
Old planning/encryption settings, if separately provisioned, are no longer consumed.
Do not delete cloud resources blindly; review any cleanup through Terraform.

Use `production` without required reviewers/wait timers for this automatic policy.
If someone configures native GitHub environment approval, GitHub itself will still
pause the job; the code does not bypass it. Restricting that environment's branches
to `main` is recommended and does not require manual approval.

Keep production credentials environment-scoped, not available to local UAT or
untrusted PR jobs. The workflow only grants id-token/write to deployment, uses AWS
OIDC for the existing deployment role, and does not request GitHub approval APIs.
The current role's broad PowerUserAccess/IAMFullAccess permissions are unchanged;
this is not a least-privilege claim. AWS backend authentication and AWS/Cloudflare
provider authentication remain distinct.

Region/workspace/tool version are configured in the workflow (`us-east-1`,
`default`, and `TERRAFORM_VERSION` today); backend key/region live in Terraform.
The API zip is built before planning, and the web build uses the API URL from
that saved plan. See the [Terraform operator guide](../infra/terraform/README.md)
for original backend, role and service-token provisioning.

## Policy scope

This is a small deployment contract, not a complete infrastructure verifier.
Known public database exposure, enabled API Gateway default endpoints and
unencrypted Aurora storage block the plan. Malformed/incomplete input fails closed.

Destruction/replacement, Access/IAM edits, DNS/CAA, hostname/routing and disabling
deletion protection are informational `REVIEW` findings. They do not pause Actions.
Unknown security settings remain unresolved findings; generated IDs/ARNs do not
produce warnings. There is no resource-address or hostname inventory to maintain.
The report is not proof of safety; human source review belongs locally/in the PR.

## Local preview and inspection

Run these yourself in your credential-bearing terminal, from the repo root:

```sh
pnpm infra:preview
pnpm infra:inspect  # Redacted inspection of the newest local saved plan
pnpm infra:review   # Full Terraform text for that local plan, in your private terminal
```

No paths or variables are needed to inspect/review the plan just created. Both
select the newest run in `.local/infra-plan/`, never silently fall back after a
failed newest run, and neither rebuilds, refreshes, approves or applies anything.
Inspection prints its run/hash and saves `policy.json`/`policy.md` alongside the
binary. Full review may expose sensitive values and refuses non-terminal output.
`review` means "show the saved local plan", not an agent review or approval token.

Advanced inputs remain optional:

```sh
bash scripts/plan-prod.sh --var-file /private/path/production.tfvars
PLAN_JSON_PATH=/private/path/plan.json pnpm infra:inspect
```

Explicit JSON inspection is labeled local preview and writes under `.local/deploy/`.
The retired `prod-infra.sh` and Actions download/decrypt `REVIEW_*` inputs are not used.
Actions plan reports are visible in GitHub; reviewing them is not a deployment gate.

Use Node 24+, installed dependencies, pnpm, Git, AWS CLI and Terraform supported by
the configuration. The preview packages Lambda, confirms backend/provider identities
independently, initializes with provider locks unchanged, validates and confirms the
backend key/region/workspace before planning. It never changes GitHub settings/secrets.

Normal tfvars/`TF_VAR_*` inputs and explicit var files are accepted. The final
temporary inputs pin the fresh Lambda path/hash and the explicitly selected provider
profile/region. `TF_PROVIDER_PROFILE` selects a profile (empty means the default
chain); otherwise the wizard prompts. `AWS_EXPECTED_REGION` defaults to `us-east-1`.
Backend and provider accounts are shown separately, not forced to match. Optional
`AWS_EXPECTED_ACCOUNT_ID` checks the local backend/preflight identity.

Backend settings come from `TF_BACKEND_BUCKET` / `TF_BACKEND_PROFILE`, relevant
AWS/Terraform settings, cached metadata or prompts. The Cloudflare management token
uses the terminal environment or hidden input and is not persisted. Expired AWS
sessions stop the preview; authenticate yourself and retry. If only backend auth
changed, verify the state location and use `--reconfigure-backend`; it refuses a
different cached bucket and is not a state migration tool.

## Verification and evidence

Before migrations, a bounded read-only Data API `SELECT 1` probe waits for Aurora
auto-resume. Only `DatabaseResumingException` is retried; other failures stop
immediately, and migration SQL itself is never blindly retried.

Both existing smoke tests must execute and pass: direct Lambda `/health` and
authenticated public DB-backed `/recipes`. Empty lists are valid; the smoke tests
do not write data. Additional checks are limited to CloudFront readiness, HTTPS and
unauthenticated access behavior for Terraform's web/API URLs, disabled API default
endpoints and matching Lambda code. They allow valid login redirects or 401/403,
multiple API mappings and IPv4/IPv6, with three attempts five seconds apart and
safe failure reasons. There is no second infrastructure inventory.

Safe reports are retained 14 days, keyed by run/attempt:

- `plan-report-<runId>-<attempt>`: policy Markdown/JSON, source/target and build hashes.
- `deployment-verification-<runId>-<attempt>`: required step outcomes, check details,
  saved-plan hash and evidence references.
- `deployment-result-<runId>-<attempt>`: overall checks/deployment outcomes, including
  failed/skipped jobs. Missing, cancelled or skipped checks are not success.

Binary plans, builds, raw plan JSON, state, outputs and diagnostics are **not**
uploaded. The runner's private plan/outputs/logs are removed in always-run cleanup.
Local material is ignored under `.local/infra-plan/` and `.local/deploy/`; share only
redacted reports with agents. Local preview logs/binaries remain for private use;
temporary identities, decoded plan JSON and artifact inputs are cleaned up on
ordinary exit. Abrupt termination can bypass cleanup. Permissions are not an agent
sandbox: processes as your OS user may access files or credentials.

#28 can consume these schema-version-1 reports without approving or mutating.
#24's built-artifact black-box UAT is separate. Future required PR checks should
reuse those acceptance commands and gate merge, not add another production approval.
No new PR gate is implemented here. #22's smoke checks were previously verified;
the revised same-job deployment workflow still needs a live run.

## Failure and recovery

Rerun/dispatch the workflow on `main` after correcting the cause. Each deployment
job starts with a fresh plan/build; it cannot fall back to an old plan or replan
after an apply failure. Partial deployment is not automatically rolled back.
Coordinate recovery, then replan against current state. A revert is reviewed and
pushed/merged through the same automatic workflow. Native stale-plan rejection
and file/target integrity failures stop before an unsafe fallback.

Tests: `pnpm test:infra`, also included in `pnpm test` and `pnpm test:unit`.
