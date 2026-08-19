# 0002. Deploy Serverless AWS Behind Cloudflare Access

Date: 2026-08-18

## Status

Accepted

## Context

The repository was intentionally created without infrastructure, CI/CD, authentication, or AWS integrations until there was a concrete need. The current need is an implementation-ready production deployment path for the React SPA and Hono API.

The deployment should stay small enough for one owner to operate, avoid introducing a database in this chunk, and preserve a low-friction path to staging later. Cloudflare already owns DNS for `rkac.dev`, and Cloudflare Access is the preferred initial access-control layer.

## Decision

Deploy the production app on AWS serverless infrastructure behind Cloudflare DNS and Cloudflare Access.

- Use `app.recipes.rkac.dev` for the SPA and `api.recipes.rkac.dev` for the API.
- Use AWS region `us-east-1`.
- Serve the SPA from private S3 through CloudFront with Origin Access Control.
- Run the Hono API as a Lambda behind API Gateway HTTP API.
- Disable API Gateway's default `execute-api` endpoint for the first infrastructure implementation.
- Manage AWS and Cloudflare resources with Terraform under `infra/terraform/`.
- Use an S3 Terraform backend with native S3 lockfile locking.
- Use Cloudflare Access with One-Time PIN email login for the owner's email as the initial policy.
- Deploy application artifacts through GitHub Actions using OIDC to assume a least-privilege AWS deploy role.
- Keep Terraform apply credentials local initially.

## Consequences

This crosses the repository's previous no-infrastructure boundary, so deployment work should stay tightly scoped to the production serverless path.

Cloudflare Access protects both hostnames at the edge, but API-side Cloudflare Access JWT verification is still required as follow-up hardening. Until then, disabling API Gateway's default endpoint reduces accidental bypass paths but is not a complete application-layer authorization model.

Terraform now becomes part of the repo's maintained surface. Backend bootstrap, production infrastructure, and operator documentation must be kept understandable for a small single-owner project.

GitHub Actions initially receives application artifact deployment permissions only. Terraform automation, database infrastructure, mature release governance, and PR-required deployment policy remain out of scope until there is a concrete need.
