# Production Infra Workflow

Use the `plan-prod` swamp workflow for local production Terraform plan review.

```sh
swamp workflow run plan-prod
```

The workflow runs preflight checks, creates a saved Terraform plan, inspects the plan for risky changes, then writes a local report. It does not apply infrastructure changes; `.github/workflows/deploy.yml` applies production Terraform after checks pass.

Required local environment:

- `CLOUDFLARE_API_TOKEN`
- `TF_VAR_cloudflare_account_id`
- `TF_VAR_cloudflare_zone_id`
- `TF_VAR_access_allowed_email`
- `TF_VAR_aws_profile`, optional, defaults to `recipes-admin`
- `TF_VAR_aws_region`, optional, defaults to `us-east-1`

The workflow does not store AWS access keys. Production automation should inject secrets through the runner environment and use the standard AWS credential chain or GitHub OIDC.

Production deployment is handled by `.github/workflows/deploy.yml`, not this swamp workflow. After bootstrapping Terraform state and applying the deploy role locally once, record these Terraform outputs and backend values as GitHub Actions production environment secrets:

- `AWS_DEPLOY_ROLE_ARN`: `terraform -chdir=infra/terraform/prod output -raw github_actions_deploy_role_arn`
- `TERRAFORM_STATE_BUCKET`: the bootstrap `terraform_state_bucket` output
- `AWS_REGION`: `us-east-1`, unless production moves regions later
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for Zero Trust resources
- `CLOUDFLARE_ZONE_ID`: Cloudflare zone ID for `rkac.dev`
- `ACCESS_ALLOWED_EMAIL`: email address allowed by the initial Access policy
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Access and DNS edit permissions

The deploy workflow uses GitHub OIDC to assume the deploy role, builds `packages/api/dist/api-lambda.zip`, applies production Terraform with that API artifact, reads Terraform outputs from remote state, builds the web artifact with the production API URL, syncs `packages/web/dist` to the output web S3 bucket, invalidates CloudFront, and runs a Lambda `/health` smoke check.

Local artifacts are intentionally ignored by git:

- `infra/terraform/prod/prod.tfplan`
- `infra/terraform/prod/prod-plan.txt`
- `infra/terraform/prod/prod-plan.json`
- `infra/terraform/prod/prod-outputs.json`
- `infra/terraform/prod/prod-outputs.env`
- `infra/terraform/prod/prod-report.txt`

This workflow is for infrastructure plan review. Do not use it for production deployment; GitHub Actions applies production Terraform and deploys built application artifacts.
