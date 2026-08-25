# Production Infra Workflow

Use the `promote-prod` swamp workflow for guarded production Terraform operations.

```sh
swamp workflow run promote-prod
```

The workflow runs preflight checks, creates a saved Terraform plan, inspects the plan, pauses for manual approval, applies the saved plan, verifies production endpoints and AWS state, then writes a local report.

Required local environment:

- `CLOUDFLARE_API_TOKEN`
- `TF_VAR_cloudflare_account_id`
- `TF_VAR_cloudflare_zone_id`
- `TF_VAR_access_allowed_email`
- `TF_VAR_aws_profile`, optional, defaults to `recipes-admin`
- `TF_VAR_aws_region`, optional, defaults to `us-east-1`

Local artifacts are intentionally ignored by git:

- `infra/terraform/prod/prod.tfplan`
- `infra/terraform/prod/prod-plan.txt`
- `infra/terraform/prod/prod-plan.json`
- `infra/terraform/prod/prod-outputs.json`
- `infra/terraform/prod/prod-outputs.env`
- `infra/terraform/prod/prod-report.txt`

This workflow is for infrastructure plan/apply/verify operations. Do not use it for application artifact deployment; GitHub Actions should deploy built web/API artifacts once that pipeline exists.
