# 0004. Use read-only service auth for production smoke tests

Date: 2026-10-15

## Status

Accepted. Implementation is validated locally; production provisioning and live
verification are still pending.

## Context

The Lambda `/health` smoke test proves the deployed handler responds, but does
not exercise recipe persistence. Production recipe routes require Cloudflare
Access authentication, so an anonymous request cannot verify the database path.

## Decision

Keep the direct-Lambda `/health` deployment check and add an authenticated public
`GET /recipes` check through Cloudflare Access, API Gateway, Lambda, and the real
production database. Do not require seed data or write test records.

The deployment workflow runs the DB-backed smoke test with
`pnpm --filter @recipes/api test:smoke`. It requires HTTP 200 and a valid
recipe-list response, accepts an empty database, rejects login redirects and
HTML responses, and exits unsuccessfully on request or validation failures.

Use a dedicated expiring Cloudflare Access service token with its own Service
Auth policy, alongside the existing owner-email policy. The API verifies the
same signed JWT issuer and audience as before, explicitly identifies the service
by its verified `common_name`, and only accepts the configured smoke Client ID.
That identity can only access `GET /recipes` on authenticated API routes; it
cannot write recipes or access `/me`. Normal user authorization is unchanged.

## Trade-offs

Calling the public API checks more of the deployed system than a direct Lambda
invocation. Extracting a service JWT for direct invocation is not a dependable
Cloudflare flow, particularly with strict service-token authentication. No JWT
echo endpoint or production auth bypass will be introduced.

The existing shared Access application covers both web and API destinations, so
the Cloudflare policy alone is not read-only. The API must enforce the service's
route/method restriction. The service may fetch static web assets, but cannot
acquire a normal user identity through the API.

Terraform manages the token and policy. Its client secret is sensitive material
in remote Terraform state, even though output is marked sensitive. Restrict state
access and never publish raw state, plans, or JSON outputs. Copy credentials
directly into GitHub's production environment secrets, rotate before expiry,
and resynchronize them after replacement. A secret or authentication failure
fails deployment; there is no anonymous or developer-identity fallback.

Saved-plan approval and deterministic pipeline inspection are separate follow-up
work in GitHub issues #14 and #28, not guarantees of the current deployment workflow.
