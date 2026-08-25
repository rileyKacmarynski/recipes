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

Local artifacts are intentionally ignored by git:

- `infra/terraform/prod/prod.tfplan`
- `infra/terraform/prod/prod-plan.txt`
- `infra/terraform/prod/prod-plan.json`
- `infra/terraform/prod/prod-outputs.json`
- `infra/terraform/prod/prod-outputs.env`
- `infra/terraform/prod/prod-report.txt`

This workflow is for infrastructure plan review. Do not use it for application artifact deployment; GitHub Actions should deploy built web/API artifacts and eventually own approved production infrastructure applies.
