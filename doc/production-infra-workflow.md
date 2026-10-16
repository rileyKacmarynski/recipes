# Production Infra Workflow

## Current workflow and limitations

GitHub Actions currently applies production Terraform and deploys application
artifacts. It does **not** apply the local script's reviewed plan: it performs its
own automatic apply. The authoritative saved-plan → human approval → exact-plan
apply workflow is planned in issue #14; read-only pipeline monitoring and evidence
collection are planned in #28. Neither is implemented yet.

The older `scripts/prod-infra.sh` is a legacy preview aid with a hard-coded backend and
limited inspection rules, not the complete account/workspace/policy verification
contract proposed in #14. Check its configuration and findings manually. For
current infrastructure prerequisites and service-token provisioning, use the
[Terraform operator guide](../infra/terraform/README.md).

## Local plan preview

Run the interactive, human-operated plan script from the repository root:

```sh
bash scripts/plan-prod.sh
# Optional explicit var files, in precedence order:
bash scripts/plan-prod.sh --var-file /path/to/production.tfvars --var-file /path/to/overrides.tfvars.json
```

The script packages the current Lambda source, confirms your backend/AWS identity,
initializes Terraform without upgrading provider locks, validates configuration,
confirms the workspace, creates a saved plan, and writes a value-redacted report.
It has no apply operation and never pushes, deploys, or changes GitHub secrets.

Terraform loads its normal local `terraform.tfvars`/`*.auto.tfvars` files and
`TF_VAR_*` environment values. Explicit `--var-file` arguments take precedence in
the order supplied. The freshly packaged Lambda path and checksum are passed in
a temporary JSON var file last, so the plan always uses that build. Other required
Terraform inputs are prompted for by Terraform itself; they are not persisted to
your configuration files. Do not put Cloudflare management credentials in tfvars.

`CLOUDFLARE_API_TOKEN` is used from the calling terminal or requested with hidden
input. It stays in the script's process environment and is not saved into a var
file, dotenv file, or GitHub secret. The parent terminal's exported variables are
unchanged when the script exits. If you exported the token yourself, remove it
from that terminal afterward with `unset CLOUDFLARE_API_TOKEN`.

Backend settings are resolved from `TF_BACKEND_BUCKET` (or
`TF_VAR_terraform_state_bucket`) and `TF_BACKEND_PROFILE`/`AWS_PROFILE`/
`TF_VAR_aws_profile`, then the initialized S3 backend metadata, then prompts. The
backend bucket is not hard-coded. An empty profile uses the default AWS credential
chain. An expired SSO session stops before planning; run `aws sso login --profile
recipes-admin` yourself and retry. Optionally set `AWS_EXPECTED_ACCOUNT_ID` to
reject a different backend/preflight identity before continuing. Provider
authentication remains controlled by Terraform configuration and may differ from
backend/preflight authentication; inspect it yourself.

If initialization reports **Backend configuration changed**, do not blindly
migrate state. Terraform also reports this when authentication settings such as
an explicit profile differ from cached initialization. After verifying that the
bucket, key, region, and workspace mapping still point at the same existing state,
run:

```sh
bash scripts/plan-prod.sh --reconfigure-backend
```

This option requires an extra confirmation and passes `-reconfigure` to init,
resetting local backend metadata without migrating remote state. It refuses a
different cached bucket; you must still verify the key/region/workspace mapping
against configuration yourself. It never uses `-migrate-state` and is not a
backend migration tool. Ordinary runs do not bypass Terraform's change warning.

Each run creates a private, gitignored directory under `.local/infra-plan/`:

- **Share only `report.md` or `report.json` with the agent.** These contain actions,
  changed top-level attribute names, redacted resource addresses, and review
  findings—not attribute/output values or provider diagnostics. JSON includes
  the source commit/dirty flag and a checksum of the saved plan.
- **Keep `plan.tfplan` and raw `*.log` files private.** Terraform output appears in
  your terminal and raw logs can contain secret-bearing diagnostics. Inspect them
  yourself if a stage fails. The report intentionally cannot expose every detail
  needed for a complete security review.
- Temporary raw plan JSON, artifact-input JSON, and AWS identity JSON are removed
  on normal completion, failure, or ordinary interruption. The binary plan and
  raw logs are retained for your review; abrupt process termination may bypass
  cleanup, so the entire directory remains private.

The script creates files with restrictive permissions and disables inherited
Terraform debug logging. This is **not an agent sandbox**: another process running
as your macOS user can still read private files or invoke credential lookup tools.
Run it yourself in a credential-bearing terminal; agents should consume only the
sanitized report, not execute the credential-bearing workflow or inspect raw plans.

A report is not approval. Unknown values, Access changes, replacements, exposed
endpoints, and selected other risks are flagged, but full policy coverage and the
authoritative saved-plan approval/apply flow remain work under #14. Terraform
exit codes 0 (no changes) and 2 (changes) both produce reports; errors stop without
producing a success report. Nothing is applied.

Test the dependency-free report helper with `pnpm test:infra`. These tests are also
included in the root `pnpm test` and `pnpm test:unit` commands. The older
`scripts/prod-infra.sh` remains a legacy preview tool; prefer the interactive script
above for this human-run/report-only workflow.

### Existing Terraform configuration

Supply these Terraform settings through standard var files or `TF_VAR_*`
environment variables; missing required values are prompted for during planning.
The provider token is separate, and the new script generates artifact inputs:

- `CLOUDFLARE_API_TOKEN`, provider environment only; prompted with hidden input when missing
- `TF_VAR_cloudflare_account_id`
- `TF_VAR_cloudflare_zone_id`
- `TF_VAR_access_allowed_email`
- `TF_VAR_cloudflare_access_team_domain`
- `TF_VAR_github_oidc_subject`
- `TF_VAR_terraform_state_bucket`
- `TF_VAR_api_lambda_zip_path` and `TF_VAR_api_lambda_source_code_hash`, supplied automatically by the new script from its packaged Lambda artifact
- `TF_VAR_aws_profile`, optional; null uses the provider's default credential chain (the existing local configuration may set `recipes-admin`)
- `TF_VAR_aws_region`, optional, defaults to `us-east-1`

The script does not store AWS access keys. Production automation should inject secrets through the runner environment and use the standard AWS credential chain or GitHub OIDC.

Production deployment is handled by `.github/workflows/deploy.yml`, not this local script. After bootstrapping Terraform state and applying the deploy role locally once, record these Terraform outputs and backend values as GitHub Actions production environment secrets:

- `AWS_DEPLOY_ROLE_ARN`: `terraform -chdir=infra/terraform/prod output -raw github_actions_deploy_role_arn`
- `TERRAFORM_STATE_BUCKET`: the bootstrap `terraform_state_bucket` output
- `AWS_REGION`: `us-east-1`, unless production moves regions later
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for Zero Trust resources
- `CLOUDFLARE_ZONE_ID`: Cloudflare zone ID for `rkac.dev`
- `ACCESS_ALLOWED_EMAIL`: email address allowed by the initial Access policy
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Access and DNS edit permissions
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`: the Cloudflare Zero Trust team domain
- `GH_OIDC_SUBJECT`: the production GitHub OIDC subject allowed by the deploy role
- `CF_ACCESS_SMOKE_CLIENT_ID` and `CF_ACCESS_SMOKE_CLIENT_SECRET`: the dedicated service-token credentials, copied from Terraform outputs as described in the operator guide

The deploy workflow uses GitHub OIDC to assume the deploy role, builds `packages/api/dist/api-lambda.zip`, checks smoke-test credential presence, applies production Terraform with that API artifact, reads Terraform outputs from remote state, applies database migrations, updates Lambda code, builds the web artifact with the production API URL, syncs `packages/web/dist` to the output web S3 bucket, invalidates CloudFront, and runs two production smoke tests:

- Direct Lambda `/health` invocation verifies handler availability.
- `pnpm --filter @recipes/api test:smoke` calls the authenticated public `GET /recipes` route through Cloudflare, API Gateway, Lambda, and the database. It requires a valid recipe-list response, including an empty list, and does not write data.

ADR 0004 records the service identity's API restrictions. Production provisioning
and live verification of that identity are pending; local test success is not
evidence that the live Access configuration works.

Local artifacts are intentionally ignored by git, but may contain secrets. Keep
them access-restricted and do not publish raw plans, state, or outputs in logs or
workflow artifacts:

- `infra/terraform/prod/prod.tfplan`
- `infra/terraform/prod/prod-plan.txt`
- `infra/terraform/prod/prod-plan.json`
- `infra/terraform/prod/prod-outputs.json`
- `infra/terraform/prod/prod-outputs.env`
- `infra/terraform/prod/prod-report.txt`

These local scripts are for infrastructure plan review. Do not use them for production deployment; GitHub Actions applies production Terraform and deploys built application artifacts.
