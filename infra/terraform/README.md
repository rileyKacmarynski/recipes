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
export TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
export TF_VAR_access_allowed_email="you@example.com"
export CLOUDFLARE_API_TOKEN="..."
```

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

Then apply:

```sh
terraform -chdir=infra/terraform/prod apply
```

Terraform creates the production AWS resources, Cloudflare DNS records, Cloudflare Access applications, and Access policies. Do not manually create S3 buckets, CloudFront distributions, Lambda functions, API Gateway resources, or app DNS records for this deployment.

Production uses one-label hostnames under `rkac.dev`, which keeps them within Cloudflare Universal SSL's wildcard coverage for the zone.

## Application Artifact Deploy

Production Terraform also creates the GitHub OIDC role used by `.github/workflows/deploy.yml` for app artifact deployment. After a local apply, store these Terraform/backend values as GitHub Actions secrets:

- `AWS_DEPLOY_ROLE_ARN`: `terraform -chdir=infra/terraform/prod output -raw github_actions_deploy_role_arn`
- `TERRAFORM_STATE_BUCKET`: the bootstrap `terraform_state_bucket` output
- `AWS_REGION`: `us-east-1`

The GitHub deploy workflow reads Terraform outputs from remote state, deploys web/API artifacts, invalidates CloudFront, and runs smoke checks. It does not run `terraform apply`.
