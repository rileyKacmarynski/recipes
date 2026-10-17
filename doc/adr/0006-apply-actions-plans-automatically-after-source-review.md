# 0006. Apply Actions plans automatically after source review

Date: 2026-10-17

## Status

Accepted. Supersedes ADR 0005 at the operator's explicit request.

## Context

The operator wants to review infrastructure changes locally or approve a PR, then
let Actions deploy without another manual approval. The separate planning/apply
jobs introduced a plan-transfer boundary, credential provisioning and encryption
keys that are unnecessary without the approval pause.

## Decision

Treat push/merge to main as permission to run production deployment. Manual dispatch
also selects main. Do not enforce a reviewer gate or call GitHub protection APIs
inside Actions; native environment settings remain the operator's responsibility.

Plan and apply in one job with existing production credentials. Build the API,
create and inspect a saved plan, build the web with its planned API URL, verify
target/file identities, and apply that exact plan automatically. Retain concurrency,
provider/tool pins, specific exposure checks and runtime smoke/verification checks.
Never substitute a newly generated plan after an apply failure.

Keep the secret-bearing plan and builds on that runner. Upload only redacted reports
and checksums. No cross-job handoff means no custom encryption, S3 transfer, planning
role/environment or additional key pair. Remove that unused code and provisioning.

Local preview stays read-only and optional. Human approval concerns source changes;
it does not prove that the freshly generated Actions plan is identical to a local
preview, since state and the merged commit can differ. No local approval cookie or
agent-supplied approval boolean is introduced.

## Consequences

An accepted main change can mutate production automatically, including destructive
changes that are reported but not prohibited by policy. Source/local review is the
human control. Agents may propose PRs, not silently authorize merge or deployment.
The existing deployment role is available during both plan and apply; this is not
credential separation or a least-privilege claim.

Future acceptance/compatibility verification can become required PR checks before
merge. That is follow-up work, separate from the deterministic commands it invokes.
No additional PR gate, agent framework or deployment approval is added here.
