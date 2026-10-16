# Production Infra Workflow

## Current workflow and limitations

GitHub Actions currently applies production Terraform and deploys application
artifacts. It does **not** apply the local script's reviewed plan: it performs its
own automatic apply. The authoritative saved-plan → human approval → exact-plan
apply workflow is planned in issue #14; read-only pipeline monitoring and evidence
collection are planned in #28. Neither is implemented yet.

The existing local script is a legacy preview aid with a hard-coded backend and
limited inspection rules, not the complete account/workspace/policy verification
contract proposed in #14. Check its configuration and findings manually. For
current infrastructure prerequisites and service-token provisioning, use the
[Terraform operator guide](../infra/terraform/README.md).

## Local plan preview

Run the existing infrastructure script from the repository root for local production Terraform plan review:

```sh
bash scripts/prod-infra.sh preflight &&
  bash scripts/prod-infra.sh plan &&
  bash scripts/prod-infra.sh inspect-plan &&
  bash scripts/prod-infra.sh report
```

These commands run preflight checks, create a saved Terraform plan, inspect the plan for risky changes, then write a local report. Each command runs only if the previous command succeeds. They do not apply infrastructure changes; `.github/workflows/deploy.yml` applies production Terraform after checks pass.

Required local environment:

- `CLOUDFLARE_API_TOKEN`
- `TF_VAR_cloudflare_account_id`
- `TF_VAR_cloudflare_zone_id`
- `TF_VAR_access_allowed_email`
- `TF_VAR_cloudflare_access_team_domain`
- `TF_VAR_github_oidc_subject`
- `TF_VAR_terraform_state_bucket`
- `TF_VAR_api_lambda_zip_path` and `TF_VAR_api_lambda_source_code_hash`, from a packaged Lambda artifact
- `TF_VAR_aws_profile`, optional, defaults to `recipes-admin`
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

This local script is for infrastructure plan review. Do not use it for production deployment; GitHub Actions applies production Terraform and deploys built application artifacts.
