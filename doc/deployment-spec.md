# Deployment Implementation Spec

## Goal

Deploy the recipes app to production on AWS serverless infrastructure behind Cloudflare DNS and Cloudflare Access, with Terraform-managed infrastructure and GitHub Actions-managed application artifact deployment.

Production URLs:

- Web SPA: `https://recipes.rkac.dev`
- API: `https://recipes-api.rkac.dev`

The first implementation should support production only while keeping staging hostnames easy to add later: `recipes-staging.rkac.dev` and `recipes-api-staging.rkac.dev`.

## Scope

Implement:

- Terraform bootstrap and production infrastructure under `infra/terraform/`.
- Private S3 plus CloudFront Origin Access Control for the SPA.
- API Gateway HTTP API plus AWS Lambda for the Hono API.
- Cloudflare DNS and Cloudflare Access resources for the app hostnames.
- GitHub Actions artifact deployment for web and API artifacts.
- Operator documentation for prerequisites, bootstrap, Terraform apply, and deploy operations.

Do not implement in this deployment chunk:

- Database or ORM infrastructure.
- Docker.
- Broad environment-variable management beyond values needed for deployment.
- API-side Cloudflare Access JWT verification. Keep this as follow-up hardening.
- PR-required merge policy or mature release governance.

## Required Decisions

- AWS region is `us-east-1`.
- Terraform CLI version is `>= 1.10.0`.
- Terraform manages AWS and Cloudflare resources.
- Terraform uses an S3 backend with native S3 lockfile locking via `use_lockfile = true`.
- Terraform lives in:
  - `infra/terraform/bootstrap/` for backend resources.
  - `infra/terraform/prod/` for production infrastructure.
  - `infra/terraform/modules/` only where a local module removes meaningful duplication.
- Terraform assumes the existing Cloudflare zone for `rkac.dev` and requires `cloudflare_account_id` and `cloudflare_zone_id` inputs. Hostnames stay one label under `rkac.dev` so Cloudflare Universal SSL covers them without a delegated subdomain zone.
- Local Terraform applies use an AWS CLI profile variable.
- Cloudflare provider authentication uses `CLOUDFLARE_API_TOKEN` from the environment.
- AWS resource names use the `recipes-prod` prefix where possible.
- AWS resources use standard tags: `Project=recipes`, `Environment=prod`, `ManagedBy=terraform`.
- Initial deploy flow builds the API Lambda artifact, applies production Terraform in GitHub Actions, then deploys web artifacts on push to `main` after checks pass.

## Infrastructure Requirements

### Web

- Build `packages/web` as a static SPA.
- Serve the SPA from a private S3 bucket through CloudFront.
- Use CloudFront Origin Access Control, not public S3 website hosting.
- Configure the production web hostname `recipes.rkac.dev` through Cloudflare DNS.
- Protect the web hostname with Cloudflare Access.

### API

- Run the Hono API on AWS Lambda behind API Gateway HTTP API.
- Bundle the Lambda handler as a zip artifact using esbuild or an equivalent minimal bundling step.
- Expose the API through `recipes-api.rkac.dev`.
- Disable API Gateway's default `execute-api` endpoint for the first infrastructure implementation.
- Keep explicit CORS handling for the separate web/API origins.
- Protect the API hostname with Cloudflare Access at the edge.

### Cloudflare Access

- Cloudflare owns DNS for the application hostnames.
- Cloudflare Access initial policy allows only the owner's email.
- Use One-Time PIN email login.
- Treat Cloudflare Zero Trust organization/team-domain setup as an external prerequisite.
- Free plan is suitable for the initial one-user setup.

## GitHub Actions Requirements

Create separate workflows:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`

`ci.yml` should run the repo's non-E2E validation appropriate for push/PR feedback: lint, typecheck, unit/package tests, and build checks as needed.

`deploy.yml` should:

- Run on push to `main` and `workflow_dispatch`.
- Run only after non-E2E checks pass in that workflow.
- Use GitHub OIDC to assume a production deploy role gated by the GitHub `production` environment.
- Build the API Lambda zip before applying Terraform so Terraform creates or updates the Lambda with the real deployable artifact.
- Apply production Terraform before reading outputs and deploying web artifacts.
- Deploy web artifacts by syncing `packages/web/dist` to the production S3 bucket and invalidating CloudFront.
- Deploy API artifacts through the Terraform-managed Lambda function code update.

The Terraform backend bootstrap remains local. After bootstrap, GitHub Actions applies production Terraform and deploys application artifacts.

## Follow-Up Implementation Tickets

### 1. Terraform Bootstrap And Production Infrastructure

Implement Terraform under `infra/terraform/` for backend bootstrap and production infrastructure.

Acceptance criteria:

- `infra/terraform/bootstrap/` creates or documents creation of the S3 backend bucket with native lockfile support.
- `infra/terraform/prod/` manages AWS and Cloudflare production resources.
- Required variables include AWS profile, Cloudflare account ID, and Cloudflare zone ID.
- Production infrastructure includes private SPA bucket, CloudFront OAC distribution, HTTP API, Lambda, custom API domain, Cloudflare DNS records, and Cloudflare Access resources.
- API Gateway default endpoint is disabled.
- Outputs expose values needed by the deploy workflow: web bucket, CloudFront distribution ID, Lambda function name, and production URLs.
- Fresh AWS account prerequisites are documented, not automated.

### 2. API Lambda Adapter And Build Artifact

Add the minimal API package support needed to run Hono on Lambda.

Acceptance criteria:

- The existing Hono app can still be tested with `app.request(...)`.
- Local development through the current Node server remains intact.
- A Lambda handler entrypoint uses Hono's AWS Lambda adapter.
- A package script or build step produces the deployable API bundle expected by the deploy workflow.
- Narrow tests cover the handler or app behavior at the package boundary.

### 3. GitHub Actions Artifact Deployment

Add CI and deploy workflows plus the AWS IAM resources needed for artifact deploy.

Acceptance criteria:

- `.github/workflows/ci.yml` runs non-E2E checks.
- `.github/workflows/deploy.yml` runs on push to `main` and manual dispatch.
- Deploy uses GitHub OIDC to assume a least-privilege AWS role.
- Web deploy syncs `packages/web/dist` to S3 and invalidates CloudFront.
- API deploy builds the Lambda artifact and updates function code.
- Deploy builds the API Lambda artifact, applies production Terraform, then deploys web artifacts.

### 4. Deployment Operator Documentation

Document how to provision and operate the deployment.

Acceptance criteria:

- Documentation lists required local tools and versions.
- Documentation lists Cloudflare Zero Trust and token prerequisites.
- Documentation lists AWS account/profile prerequisites.
- Documentation explains bootstrap, production Terraform init/apply, and artifact deploy flow.
- Documentation explains rollback/redeploy basics for web and API artifacts.

### 5. Cloudflare Access JWT Verification Hardening

Implement after first infrastructure is deployed.

Acceptance criteria:

- Add Hono middleware that verifies Cloudflare Access JWTs using Cloudflare JWKS.
- Configure with `CLOUDFLARE_ACCESS_JWT_REQUIRED`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, and `CLOUDFLARE_ACCESS_AUD`.
- Production requires verification once configured.
- Strict CORS preflight remains allowed without JWT verification.
- Tests cover valid token, invalid token, missing token, disabled verification, and preflight behavior.

## Durable Decision Record

Create `doc/adr/0002-deploy-serverless-aws-behind-cloudflare-access.md` to record the deployment platform decision.

## Verification Expectations

Implementation work should run the narrowest relevant checks first, then root checks where appropriate:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

E2E tests are not required for the initial deployment workflow gate unless a later ticket explicitly adds them.
