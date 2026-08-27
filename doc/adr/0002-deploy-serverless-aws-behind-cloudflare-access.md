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
- Deploy production infrastructure and application artifacts through GitHub Actions using OIDC to assume a production deploy role gated by the GitHub `production` environment.
- Keep Terraform backend bootstrap local.

Deployment automation refinements:

- The production GitHub Actions deploy role trusts the GitHub OIDC `environment:production` subject, not every `main` branch workflow run.
- Deploy configuration values that should not be visible in a public repository, such as the AWS deploy role ARN, Terraform state bucket name, Cloudflare account/zone IDs, allowed Access email, and Cloudflare API token, are stored as GitHub environment secrets.
- Production and future non-production environments should use separate AWS deploy roles and separate Terraform state keys, even if they share the same backend bucket.
- The deployment workflow builds the API Lambda artifact before applying production Terraform, so Terraform creates or updates the Lambda with the real deployable code while also reconciling infrastructure drift before web artifact rollout.
- Post-deploy smoke checks verify deployable artifacts through AWS-controlled paths, such as direct Lambda `/health` invocation, rather than treating Cloudflare Access-protected public URLs as unauthenticated smoke-test targets.

## Consequences

This crosses the repository's previous no-infrastructure boundary, so deployment work should stay tightly scoped to the production serverless path.

Cloudflare Access protects both hostnames at the edge, but API-side Cloudflare Access JWT verification is still required as follow-up hardening. Until then, disabling API Gateway's default endpoint reduces accidental bypass paths but is not a complete application-layer authorization model.

Terraform now becomes part of the repo's maintained surface. Backend bootstrap, production infrastructure, and operator documentation must be kept understandable for a small single-owner project.

GitHub Actions now receives production infrastructure deployment permissions. Database infrastructure, mature release governance, and PR-required deployment policy remain out of scope until there is a concrete need.
