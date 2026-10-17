# Terraform Infrastructure

Terraform manages the recipes production AWS and Cloudflare infrastructure.

## Layout

- `bootstrap/` creates the S3 backend bucket used by environment roots.
- `modules/app_environment/` contains reusable per-environment app infrastructure.
- `prod/` wires the production environment to `modules/app_environment/`.

Future staging infrastructure should use a separate environment root, for example `staging/`, that calls the same `app_environment` module with one-label staging hostnames under `rkac.dev`, such as `recipes-staging.rkac.dev` and `recipes-api-staging.rkac.dev`.

## Prerequisites

- Terraform CLI supported by `required_version`; Actions pins its own version in the workflow
- AWS CLI profile with access to the `recipes` AWS account
- AWS region `us-east-1`
- Cloudflare zone for `rkac.dev`
- Cloudflare Zero Trust organization with One-Time PIN configured manually
- Cloudflare API token exported as `CLOUDFLARE_API_TOKEN`

The **protected mutation** Cloudflare token needs permissions for:

- Account / Access: Apps and Policies / Edit
- Account / Access: Service Tokens / Edit (for the dedicated deployment smoke token)
- Zone / DNS / Edit
- Zone / Zone / Read

Authoritative planning uses a separate read-only token and AWS role, not these
mutation credentials. See the [production workflow prerequisites](../../doc/production-infra-workflow.md#one-time-operator-prerequisites).

Required local environment:

```sh
export TF_VAR_aws_profile="recipes-admin"
export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID"
export TF_VAR_cloudflare_access_team_domain="your-team.cloudflareaccess.com"
export TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
export TF_VAR_access_allowed_email="you@example.com"
export CLOUDFLARE_API_TOKEN="..."
```

Production API requests validate Cloudflare Access JWTs with the shared web/API Access audience. Local development uses the local auth provider when `NODE_ENV=development`.

Production database access uses Aurora PostgreSQL Serverless v2 through the RDS Data API. Terraform creates a dedicated private database VPC with no internet gateway, NAT gateway, or public database access. Lambda receives `DATABASE_DRIVER=data-api` plus the database name, cluster ARN, and Secrets Manager credential secret ARN from Terraform-managed resources.

## Bootstrap State Backend

Run bootstrap first with local state:

```sh
terraform -chdir=infra/terraform/bootstrap init
terraform -chdir=infra/terraform/bootstrap apply
```

Record the `terraform_state_bucket` output. Production uses that bucket with Terraform's native S3 lockfile locking.

## Production

Initialize production with the bootstrap bucket:

```sh
terraform -chdir=infra/terraform/prod init \
  -backend-config="bucket=<terraform_state_bucket>" \
  -backend-config="profile=recipes-admin"
```

For an ordinary local preview, use the plan-only wizard (it independently checks
backend and provider identities and never applies):

```sh
pnpm infra:preview
```

Terraform creates the production AWS resources, Cloudflare DNS records, Cloudflare Access applications, and Access policies. Do not manually create S3 buckets, CloudFront distributions, Lambda functions, API Gateway resources, or app DNS records for this deployment.

Terraform also creates the production Aurora PostgreSQL cluster, the managed Secrets Manager credential secret, runtime Lambda database permissions, and deploy-role Data API permissions needed by migration tooling.

Production uses one-label hostnames under `rkac.dev`, which keeps them within Cloudflare Universal SSL's wildcard coverage for the zone.

## GitHub Production Deploy

Production Terraform defines separate planning and deployment GitHub OIDC roles.
Existing production uses the deploy role; the new read-only planning role is a
separately authorized operator bootstrap prerequisite. Configure the required
human approval, branch restrictions and encrypted handoff before enabling the new
workflow, as described in the [production workflow runbook](../../doc/production-infra-workflow.md).
Keep these existing mutation/backend settings in GitHub's protected production
environment (never repository-level mutation secrets):

- `AWS_DEPLOY_ROLE_ARN`: `terraform -chdir=infra/terraform/prod output -raw github_actions_deploy_role_arn`
- `TERRAFORM_STATE_BUCKET`: the bootstrap `terraform_state_bucket` output
- Region is pinned to `us-east-1` in the workflow
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for Zero Trust resources
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`: Cloudflare Zero Trust team domain, for example `your-team.cloudflareaccess.com`
- `CLOUDFLARE_ZONE_ID`: Cloudflare zone ID for `rkac.dev`
- `ACCESS_ALLOWED_EMAIL`: email address allowed by the initial Access policy
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Access and DNS edit permissions

Actions builds the API and web once, creates the authoritative saved plan with
read-only credentials, waits for the sole human reviewer (self-review allowed),
then applies exactly that plan and deploys those matching builds. It reads outputs
privately, migrates the database, invalidates CloudFront and runs both smoke tests
and infrastructure verification. Local previews cannot authorize that plan.

Database-related outputs available to deployment and migration steps:

- `database_driver`: production database driver, currently `data-api`
- `database_name`: Aurora database name
- `database_resource_arn`: Aurora cluster ARN for RDS Data API calls
- `database_secret_arn`: Secrets Manager credential secret ARN, marked sensitive

Do not reuse the deploy role for planning or bypass approval to bootstrap missing
permissions. Any initial credential/IAM provisioning or exceptional recovery must
be separately authorized and coordinated; routine production changes use Actions.

## DB-backed production smoke test

Deployment retains the direct-Lambda `/health` smoke test and also makes an authenticated
public `GET /recipes` request through Cloudflare, API Gateway, Lambda, and Aurora.
It requires HTTP 200 and a valid recipe-list response, including an empty list;
it does not seed or mutate production data. Redirects, authentication errors,
network failures, and invalid response shapes fail the deployment. Recipe contents
and credentials are not printed by the smoke-test command.

The workflow invokes `pnpm --filter @recipes/api test:smoke`. To run that same
DB-backed smoke test explicitly, supply `API_URL`, `CF_ACCESS_SMOKE_CLIENT_ID`,
and `CF_ACCESS_SMOKE_CLIENT_SECRET` through a secure environment. This command
contacts the supplied deployed API; it is not part of ordinary `pnpm test` or
the local container-backed integration suites.

Terraform creates a dedicated one-year Access service token and a Service Auth
policy alongside the owner's email policy. The API only accepts this configured
service Client ID and limits its authenticated access to `GET /recipes`.
Cloudflare itself grants the token access to the shared web/API application;
the API's method/path authorization is what prevents recipe writes and `/me`
access. See ADR 0004 for this security boundary.

Before the first deploy using this check:

1. Ensure the Terraform Cloudflare API token has the service-token permission
   above. This is distinct from the smoke token and must not be used as a smoke
   request credential.
2. Provision the initial service identity as a separately authorized bootstrap
   prerequisite. For existing environments, use the authoritative saved-plan
   approval flow; a local preview is not deployment authorization.
3. Copy the created credentials directly into GitHub's production environment
   secrets, without displaying them or saving them in the repository:

   ```sh
   terraform -chdir=infra/terraform/prod output -raw smoke_access_client_id \
     | gh secret set CF_ACCESS_SMOKE_CLIENT_ID --env production
   terraform -chdir=infra/terraform/prod output -raw smoke_access_client_secret \
     | gh secret set CF_ACCESS_SMOKE_CLIENT_SECRET --env production
   ```

4. Deploy the updated API and run the workflow to verify live authentication and
   the production database. Local tests do not prove the live organization's
   Access configuration works. Missing credentials fail workflow preflight.

Terraform state now contains the service-token secret. Sensitive outputs hide it
in normal terminal output but do not encrypt or remove it from state or
`terraform output -json`. Protect remote state, plan files, and local output files;
do not upload them as workflow artifacts. The workflow reads outputs through a
private file and removes it in the job's always-run cleanup.

Rotate before the token's one-year expiry. Replace the dedicated token using a
reviewed Terraform plan, copy both replacement outputs into GitHub again, and
redeploy so the API's allowed Client ID matches the new token. Do not rotate by
changing only GitHub secrets or disabling JWT validation.

To redeploy, dispatch a new run on `main` or rerun planning, then approve its plan. To
roll back, revert through a new main commit and the same approval flow. Do not
rerun a previous apply job, deploy arbitrary old refs, or rebuild after approval.
Expired/stale/mismatched plans require a new run and human review; partial
deployment is not automatically rolled back. See the runbook for exact-run
verification reports and safe recovery. Read-only monitoring remains #28.
