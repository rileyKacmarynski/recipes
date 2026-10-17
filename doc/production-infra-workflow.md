# Production Infra Workflow

## What this guarantees

Local previews are read-only and **never authorize deployment**. On a push to
`main` (or manual dispatch selecting `main`), Actions:

1. Runs checks and builds the API at the pinned commit.
2. Plans with read-only credentials, inspects the saved plan, and builds the web
   using the API URL from that plan. It encrypts the exact plan and both builds.
3. Waits for GitHub's protected `production` environment approval.
4. Verifies the approved handoff's run/attempt, commit, target and file hashes.
5. Applies that saved plan without replanning, migrates the database, deploys the
   saved builds and invalidates CloudFront.
6. Runs smoke tests and a small set of deployment checks, then retains safe reports.

This is a contract for the current application, not a comprehensive infrastructure
verifier. New resources, hostnames, certificate names, DNS-only records and renamed
modules do not require a second inventory. An unrelated merge to `main` does not
invalidate an otherwise matching approved plan. Terraform itself rejects a saved
plan whose underlying state has changed.

Workflow-wide `production-deploy` concurrency covers planning, approval, mutation
and verification. Terraform locks protect individual operations, not the entire
review window. Coordinate any separately authorized operator mutation with this
workflow. GitHub can replace an older pending run with a newer pending run.

## Code and commands

| Piece                                     | Responsibility                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy.yml`            | Job order, approval, credentials, concurrency, apply/deploy commands and evidence retention |
| `scripts/production-deployment.ts`        | Actions-only initialization, authoritative planning, build/handoff integrity checks         |
| `scripts/deployment-policy.ts`            | Small pure policy checker and value-redacted report                                         |
| `scripts/deployment-handoff.ts`           | Encrypted transfer, expiry and matching plan/build identities                               |
| `scripts/verify-production.ts`            | Safe output handling and minimal post-deploy checks                                         |
| `scripts/plan-prod.sh` / `infra-plan.mjs` | Local preview and private inspection; no apply or approval                                  |

Operator entrypoints:

```sh
pnpm infra:preview
# Inspect or privately review the newest local preview — no paths:
pnpm infra:inspect
pnpm infra:review
# Optional standard var files, in precedence order:
bash scripts/plan-prod.sh --var-file /private/path/production.tfvars
# Advanced: inspect a specific existing private JSON file instead:
PLAN_JSON_PATH=/private/path/plan.json pnpm infra:inspect
```

`infra:inspect` automatically selects the newest run under `.local/infra-plan/`,
reads its saved binary plan without planning again, prints a redacted inspection,
and saves `policy.json`/`policy.md` alongside that plan. It identifies the run and
plan hash. It never silently falls back to an older preview if the newest run
failed. `infra:review` opens that same local binary plan as full Terraform text in
your private terminal; raw review refuses non-terminal output because it may
contain secrets. Neither command rebuilds, refreshes, approves or applies anything.

The optional `PLAN_JSON_PATH` override still accepts an explicitly selected JSON
file and writes reports under `.local/deploy/`. Exit 1 means a missing/unfinished
preview, unreadable/malformed input, or a known exposure violation. A local
report or binary plan cannot be passed to Actions for apply. The older
`scripts/prod-infra.sh` has been removed.

## What policy blocks, and what you review

The only infrastructure-value hard blocks are known public database exposure,
enabled API Gateway default endpoints, and unencrypted Aurora storage. Malformed
or incomplete plan input also fails closed.

Destruction/replacement, Access/IAM edits, DNS/CAA and hostname/routing changes,
and disabling database deletion protection are **review findings**, not forbidden
architecture changes. The report lists all managed resource actions. Unknown
security settings remain unresolved findings; ordinary generated IDs/ARNs do not
produce warnings. No report claims that the plan is proven safe.

There is no hard-coded resource list, hostname/SAN/alias list, or required CAA
resource address. Terraform configuration and human review own those decisions.

## One-time operator prerequisites

The public repository supports GitHub environment approval. At implementation
time, `production` had no protection rules, repository-level secrets were empty,
and existing mutation/smoke secrets were scoped to `production`. `production-plan`
did not exist. No settings, keys or cloud resources were changed by the agent.

### GitHub environments

Configure **Settings → Environments → production**:

- Required reviewer: initially `rileyKacmarynski`, with self-review allowed, as
  agreed. You can add reviewers or disable self-review later without changing code.
- Disable administrator bypass.
- Selected deployment branches: exactly the `main` branch, not a tag.

Create `production-plan`, also restricted to `main`, without an approval gate.
Runtime checks enforce the approval/branch protections, not exact reviewer names
or membership. Agents must never approve through UI, CLI or API on your behalf.

Keep mutation credentials only in protected `production`, never at repository
scope or in `production-plan`. `GITHUB_TOKEN` needs contents/read and actions/read;
only planning/deployment jobs get id-token/write. Approval is enforced by GitHub,
not a caller-provided boolean or dispatch input.

### Planning and deployment credentials

Provision the separate planning role as a **separately authorized operator bootstrap**:

- Terraform definitions: `infra/terraform/prod/github-actions.tf`.
- Output: `github_actions_plan_role_arn`; put it in `production-plan` as `AWS_PLAN_ROLE_ARN`.
- Trust the configured GitHub subject for `production-plan`. Terraform derives it
  from the supplied deployment subject by changing only the environment suffix,
  preserving any repository/owner IDs.
- AWS ReadOnlyAccess plus backend state read and writes only to the state lock object.
- `CLOUDFLARE_PLAN_API_TOKEN`: production account/zone-scoped DNS and Access
  applications/policies/service-token **read** permissions. Never reuse the edit token.

Copy the non-mutation Terraform inputs into `production-plan`:
`TERRAFORM_STATE_BUCKET`, `ACCESS_ALLOWED_EMAIL`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, and `GH_OIDC_SUBJECT`.
Use the actual configured GitHub OIDC subject for `GH_OIDC_SUBJECT`, including
ID-qualified subjects such as `repo:owner@id/repo@id:environment:production`.
It identifies the deployment environment, not the planning environment. Subjects
are opaque configuration values: the scripts do not reconstruct or validate their
format from repository names. IAM uses the supplied value verbatim.

Keep these existing secrets in `production`: `AWS_DEPLOY_ROLE_ARN`,
`TERRAFORM_STATE_BUCKET`, `CLOUDFLARE_API_TOKEN` (edit token),
`CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_SMOKE_CLIENT_ID`, and
`CF_ACCESS_SMOKE_CLIENT_SECRET`. Retain the other existing Terraform settings there
as needed for operator tooling.

Set repository variable `PRODUCTION_AWS_ACCOUNT_ID` to the intended account.
Region/workspace are configured once in the workflow (`us-east-1` / `default`
today); state key/backend region live in Terraform's backend configuration.
Actions checks STS identity and configured backend/workspace before planning, then
requires those identities to match at apply. Provider profile is null in Actions,
so AWS provider credentials use the assumed role rather than a local profile.

The deployment role's environment-scoped OIDC trust is defined/enforced by
Terraform and AWS. Operator provisioning must preserve that isolation; there is
no custom runtime IAM-policy interpreter. The existing deployment role remains
broad (PowerUserAccess and IAMFullAccess plus app/migration policies); this change
does not claim least privilege. Backend AWS authentication and provider
authentication (AWS/Cloudflare) remain distinct.

### Handoff encryption

Generate the RSA key yourself outside the checkout in a private terminal:

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out deployment-private.pem
openssl pkey -in deployment-private.pem -pubout -out deployment-public.pem
gh variable set DEPLOY_PLAN_PUBLIC_KEY < deployment-public.pem
gh secret set DEPLOY_PLAN_PRIVATE_KEY --env production < deployment-private.pem
```

Keep the private key in your password manager; remove the temporary key file
yourself after confirming storage. Never send it to an agent or put it at repo/
planning-environment scope. Rotate both keys together and generate new handoffs.

The bundle uses AES-256-GCM with an RSA-OAEP-SHA256-wrapped random key. Only
ciphertext is uploaded, retained for one day. Plans expire after **one day**, matching
the handoff retention rather than imposing a separate two-hour review deadline.
Identity and checksums bind the run/attempt, commit, backend/account/workspace,
Terraform/configuration/provider selections, and every plan/build byte. Missing,
expired or mismatched material never triggers a replacement plan after approval.

This encrypted handoff is a repo-specific implementation, not a requirement for
every Terraform project. Removing it requires alternative restricted storage:
ordinary public artifacts are not appropriate for secret-bearing plans/state.

## Local preview details

Use Node 24+, installed workspace dependencies, pnpm, Git, AWS CLI and a Terraform
version supported by the configuration. Actions pins its version once via
`TERRAFORM_VERSION` in the workflow. The interactive wizard packages the current Lambda,
confirms backend and provider identities independently, initializes without
upgrading locks, validates, and confirms backend key/region/workspace before planning.
It never applies, pushes, deploys or changes GitHub settings/secrets.

Normal tfvars/`TF_VAR_*` inputs are accepted. Explicit var files win in their order;
the final temporary input file pins the fresh Lambda path/hash and your explicitly
selected provider profile/region. `TF_PROVIDER_PROFILE` can select a profile
(empty means default chain); otherwise the wizard prompts. `AWS_EXPECTED_REGION`
defaults to `us-east-1` and can select another intended region. Backend and provider
accounts are shown separately, not required to be identical. An optional
`AWS_EXPECTED_ACCOUNT_ID` checks the backend/preflight identity.

Backend bucket/profile come from `TF_BACKEND_BUCKET` / `TF_BACKEND_PROFILE`, relevant
AWS/Terraform environment settings, cached backend metadata, or prompts. The
Cloudflare management token is taken from the terminal or hidden input and is not
persisted. An expired AWS session stops the preview; authenticate yourself and retry.

If only backend authentication changed, verify the state location and use
`--reconfigure-backend`. It refuses a different cached bucket and is not a state
migration tool. Never use migration/reconfiguration blindly to bypass a warning.

Private runs live under ignored `.local/infra-plan/`; inspection material lives
under ignored `.local/deploy/`. Share only value-redacted reports with agents.
Raw binary plans, decoded JSON, state, outputs and diagnostics can contain secrets.
Temporary plan JSON/artifact inputs/identities are removed on ordinary exit; raw
logs and binary previews remain for your private inspection. Abrupt termination
can bypass cleanup. Restrictive permissions are not an agent sandbox: processes
running as your OS user may still access files/credentials.

## Actions plan review stays in GitHub

Open the Actions run and review its authoritative plan/policy summary, findings,
commit, expiry and saved-plan hash. Approve or reject the waiting `production`
deployment using GitHub's environment review UI. No local download, decryption,
key entry or path copying is required. The encrypted artifact is a machine-to-machine
handoff between Actions jobs, not an operator review command.

`pnpm infra:review` is only for your local preview. The old `REVIEW_*` download/
decrypt inputs are no longer supported. Agents consume only redacted reports and
must never submit approval on your behalf.

## Verification, evidence and recovery

Both original smoke tests must execute and pass: direct-Lambda `/health` and
authenticated public DB-backed `/recipes` through Cloudflare/API Gateway/Lambda.
Empty recipe lists are valid; the tests do not write recipe data. #22 was deployed
and verified before these workflow changes; the new workflow still needs setup
and an approved live validation run.

The additional verifier is intentionally small: CloudFront ready/enabled, HTTPS
and unauthenticated access denial/login for the web/API URLs from Terraform,
disabled API Gateway default endpoints, and exact deployed Lambda build hash.
HTTPS exercises DNS (IPv4 or IPv6) and certificate validation. Access checks accept
valid redirect statuses or 401/403, without requiring a particular Cloudflare
header. Multiple API domain mappings are allowed. Checks retry at most three times,
five seconds apart, recording attempts and safe failure reasons. There is no
second hostname, CAA, Lambda-environment or database-topology inventory.

Reports, retained 14 days and keyed by **run and attempt**:

- `plan-review-<runId>-<attempt>`: policy Markdown/JSON and manifest; no raw values.
- `deployment-verification-<runId>-<attempt>`: required step outcomes, individual
  checks when executed, plan/handoff hashes and evidence references.
- `deployment-result-<runId>-<attempt>`: stage outcomes even if planning fails or
  deployment is skipped. Missing/cancelled/skipped checks are not success.

These are schema-version-1 reports for #28's separate read-only monitor, not a
permanent audit archive. Monitoring must not approve or mutate anything.

Rerunning the workflow is allowed: its planning job creates a new attempt-specific
plan/build handoff and deployment requires approval again. **Rerunning only apply
cannot reuse a previous attempt's plan.** Rerun planning as well, or dispatch a
new main run. A newer main commit alone does not require replanning; changed state,
expiry, missing material, or identity/integrity failure does.

On failure, fix the cause and create/review a fresh plan. Never regenerate after
approval, edit checksums/expiry to force acceptance, or fall back to automatic
unsaved apply. Partial deployment is not automatically rolled back. Coordinate
separately authorized recovery, then replan against current state. A revert goes
through the same plan/approval flow. Raw Terraform diagnostics remain private;
only safe findings, stage/check identifiers and controlled failure reasons are logged.

Tests: `pnpm test:infra`, also included in `pnpm test` and `pnpm test:unit`.
