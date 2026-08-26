# Production Infra Workflow

Use the `plan-prod` swamp workflow for production Terraform plan review.

```sh
swamp workflow run plan-prod
```

The workflow runs preflight checks, creates a saved Terraform plan, inspects the plan for risky changes, then writes a local report. It does not apply infrastructure changes.

Required local environment:

- `CLOUDFLARE_API_TOKEN`
- `TF_VAR_cloudflare_account_id`
- `TF_VAR_cloudflare_zone_id`
- `TF_VAR_access_allowed_email`
- `TF_VAR_aws_profile`, optional, defaults to `recipes-admin`
- `TF_VAR_aws_region`, optional, defaults to `us-east-1`

The workflow does not store AWS access keys. Production automation should inject secrets through the runner environment and use the standard AWS credential chain or GitHub OIDC.

Application artifact deployment is handled by `.github/workflows/deploy.yml`, not this swamp workflow. After applying production Terraform locally, record these Terraform outputs and backend values as GitHub Actions secrets:

- `AWS_DEPLOY_ROLE_ARN`: `terraform -chdir=infra/terraform/prod output -raw github_actions_deploy_role_arn`
- `TERRAFORM_STATE_BUCKET`: the bootstrap `terraform_state_bucket` output
- `AWS_REGION`: `us-east-1`, unless production moves regions later

The deploy workflow uses GitHub OIDC to assume the deploy role, reads Terraform outputs from remote state, syncs `packages/web/dist` to the output web S3 bucket, updates the output Lambda function from `packages/api/dist/api-lambda.zip`, invalidates CloudFront, and runs unauthenticated smoke checks against the production web URL and `/health` API URL. Terraform apply remains local-only.

Local artifacts are intentionally ignored by git:

- `infra/terraform/prod/prod.tfplan`
- `infra/terraform/prod/prod-plan.txt`
- `infra/terraform/prod/prod-plan.json`
- `infra/terraform/prod/prod-outputs.json`
- `infra/terraform/prod/prod-outputs.env`
- `infra/terraform/prod/prod-report.txt`

This workflow is for infrastructure plan review. Do not use it for application artifact deployment; GitHub Actions deploys built web/API artifacts. Terraform applies remain local-only until a later explicit infrastructure automation decision.
