# 0002. Deploy Serverless AWS Behind Cloudflare Access

Date: 2026-08-18

## Status

Accepted

## Context

The repository was intentionally created without infrastructure, CI/CD, authentication, or AWS integrations until there was a concrete need. The current need is an implementation-ready production deployment path for the React SPA and Hono API.

The deployment should stay small enough for one owner to operate, avoid introducing a database in this chunk, and preserve a low-friction path to staging later. Cloudflare already owns DNS for `rkac.dev`, and Cloudflare Access is the preferred initial access-control layer.

## Decision

Deploy the production app on AWS serverless infrastructure behind Cloudflare DNS and Cloudflare Access.

- Use `recipes.rkac.dev` for the SPA and `recipes-api.rkac.dev` for the API.
- Keep app hostnames one label under the existing `rkac.dev` Cloudflare zone so Cloudflare Universal SSL can cover them without subdomain-zone entitlement.
- Use AWS region `us-east-1`.
- Serve the SPA from private S3 through CloudFront with Origin Access Control.
- Run the Hono API as a Lambda behind API Gateway HTTP API.
- Disable API Gateway's default `execute-api` endpoint for the first infrastructure implementation.
- Manage AWS and Cloudflare resources with Terraform under `infra/terraform/`.
- Use an S3 Terraform backend with native S3 lockfile locking.
- Use Cloudflare Access with One-Time PIN email login for the owner's email as the initial policy.
- Protect the SPA and API hostnames with one Cloudflare Access application so browser session establishment and API JWT validation use the same Access audience.
- Deploy production infrastructure and application artifacts through GitHub Actions using OIDC to assume a production deploy role gated by the GitHub `production` environment.
- Keep Terraform backend bootstrap local.

Deployment automation refinements:

- The production GitHub Actions deploy role trusts the GitHub OIDC `environment:production` subject, not every `main` branch workflow run.
- Deploy configuration values that should not be visible in a public repository, such as the AWS deploy role ARN, Terraform state bucket name, Cloudflare account/zone IDs, allowed Access email, and Cloudflare API token, are stored as GitHub environment secrets.
- Production and future non-production environments should use separate AWS deploy roles and separate Terraform state keys, even if they share the same backend bucket.
- The deployment workflow builds the API Lambda artifact before applying production Terraform, so Terraform creates or updates the Lambda with the real deployable code while also reconciling infrastructure drift before web artifact rollout.
- Post-deploy smoke tests retain direct Lambda `/health` invocation and add an authenticated public `GET /recipes` request through Cloudflare and Lambda to verify the database path. Public Access-protected routes are not anonymous smoke-test targets; ADR 0004 records the dedicated read-only service identity.

## Consequences

This crosses the repository's previous no-infrastructure boundary, so deployment work should stay tightly scoped to the production serverless path.

Cloudflare Access protects both hostnames at the edge. The API now also validates Access JWT signatures, issuer, and audience. ADR 0004 adds explicit service-identity authorization for production smoke tests; disabling API Gateway's default endpoint is defense in depth, not a replacement for those checks.

Terraform now becomes part of the repo's maintained surface. Backend bootstrap, production infrastructure, and operator documentation must be kept understandable for a small single-owner project.

GitHub Actions receives production infrastructure deployment permissions. ADR 0003 subsequently introduced database infrastructure. Reviewed saved-plan deployment and deterministic pipeline inspection are tracked in issues #14 and #28; the current workflow does not yet implement that approval boundary.
