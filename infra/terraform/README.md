# Terraform Infrastructure

Terraform manages the recipes production AWS and Cloudflare infrastructure.

## Layout

- `bootstrap/` creates the S3 backend bucket used by environment roots.
- `modules/app_environment/` contains reusable per-environment app infrastructure.
- `prod/` wires the production environment to `modules/app_environment/`.

Future staging infrastructure should use a separate environment root, for example `staging/`, that calls the same `app_environment` module with one-label staging hostnames under `rkac.dev`, such as `recipes-staging.rkac.dev` and `recipes-api-staging.rkac.dev`.

## Prerequisites

- Terraform CLI `>= 1.10.0`
- AWS CLI profile with access to the `recipes` AWS account
- AWS region `us-east-1`
- Cloudflare zone for `rkac.dev`
- Cloudflare Zero Trust organization with One-Time PIN configured manually
- Cloudflare API token exported as `CLOUDFLARE_API_TOKEN`

The Cloudflare token needs permissions for:

- Account / Access: Apps and Policies / Edit
- Zone / DNS / Edit
- Zone / Zone / Read

Required local environment:

```sh
export TF_VAR_aws_profile="recipes-admin"
export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID"
export TF_VAR_cloudflare_access_team_domain="your-team.cloudflareaccess.com"
export TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
export TF_VAR_access_allowed_email="you@example.com"
export CLOUDFLARE_API_TOKEN="..."
```

`CLOUDFLARE_ACCESS_JWT_REQUIRED` is a production Lambda runtime setting managed by Terraform. Do not export it for normal local development or local Playwright runs unless you are deliberately testing Access JWT enforcement.

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

Then package the API Lambda and apply once locally after bootstrap, and again any time the GitHub deploy role permissions themselves need to change:

```sh
pnpm --filter @recipes/api package:lambda
export TF_VAR_api_lambda_zip_path="$PWD/packages/api/dist/api-lambda.zip"
export TF_VAR_api_lambda_source_code_hash="$(openssl dgst -sha256 -binary "$TF_VAR_api_lambda_zip_path" | openssl base64 -A)"
terraform -chdir=infra/terraform/prod apply
```

Terraform creates the production AWS resources, Cloudflare DNS records, Cloudflare Access applications, and Access policies. Do not manually create S3 buckets, CloudFront distributions, Lambda functions, API Gateway resources, or app DNS records for this deployment.

Production uses one-label hostnames under `rkac.dev`, which keeps them within Cloudflare Universal SSL's wildcard coverage for the zone.

## GitHub Production Deploy

Production Terraform creates the GitHub OIDC role used by `.github/workflows/deploy.yml` for production infrastructure and app artifact deployment. After a local apply, store these Terraform/backend values as GitHub Actions production environment secrets:

- `AWS_DEPLOY_ROLE_ARN`: `terraform -chdir=infra/terraform/prod output -raw github_actions_deploy_role_arn`
- `TERRAFORM_STATE_BUCKET`: the bootstrap `terraform_state_bucket` output
- `AWS_REGION`: `us-east-1`
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for Zero Trust resources
- `CLOUDFLARE_ACCESS_TEAM_DOMAIN`: Cloudflare Zero Trust team domain, for example `your-team.cloudflareaccess.com`
- `CLOUDFLARE_ZONE_ID`: Cloudflare zone ID for `rkac.dev`
- `ACCESS_ALLOWED_EMAIL`: email address allowed by the initial Access policy
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Access and DNS edit permissions

The GitHub deploy workflow builds the API Lambda zip, applies production Terraform with that artifact, reads Terraform outputs from remote state, deploys web artifacts, invalidates CloudFront, and runs smoke checks.

Because the deploy role is itself managed by Terraform, permission changes to that role still require a local production apply before GitHub Actions can use the new permissions.

To redeploy or roll back application code, rerun `.github/workflows/deploy.yml` on the desired commit. The workflow rebuilds the API Lambda zip from that commit, applies Terraform with that artifact, rebuilds the web app with the production API URL, uploads web assets, invalidates CloudFront, and runs the Lambda smoke check.
