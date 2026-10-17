# 0005. Review authoritative Actions plans before production mutation

Date: 2026-10-15

## Status

Accepted. Operator approval policy confirmed: rileyKacmarynski is the sole
required reviewer and self-review is allowed. Environment/credential bootstrap
and a live approved validation run remain required.

Scope refined on 2026-10-16 at the operator's request: keep the workflow small,
without incidental inventory/topology blockers or an exhaustive verifier.

## Context

Local plan previews and the old Actions automatic apply were independent plans.
Reviewing a local preview could not authorize the exact infrastructure and builds
that Actions would deploy. Production plans/state can also contain Cloudflare
service-token secrets; ordinary public workflow artifacts are not safe handoffs.
The single operator needs human approval without a mandatory second person.

## Decision

Keep local commands read-only and explicitly non-authoritative. Actions builds
both application artifacts at one pinned main commit and creates the authoritative
saved binary plan with separate read-only provider/backend credentials. A
schema-validated pure policy core reports known violations, human-review findings,
and unresolved security settings without publishing payloads. Ordinary computed
metadata is not a finding. Architecture changes (DNS/CAA, routing, IAM/Access,
destruction and disabling deletion protection) are reviewable, not prohibited.
There are no hard-coded resource/hostname inventories. Only known public database
exposure, enabled API default endpoints and missing Aurora encryption block policy.

Use GitHub's production environment required-reviewer protection, self-review
allowed, administrator bypass disabled, and main-only branch selection. Verify
those GitHub protections before planning and applying, without pinning reviewer
membership or self-review settings in code. AWS enforces the environment-scoped
role trust configured by Terraform; no custom IAM-policy interpreter is added.
Agents never approve on the operator's behalf. Manual
dispatch or caller-supplied approval booleans are not substitutes.

Transfer the saved plan and matching builds as an authenticated encrypted bundle.
Only the protected job has its private decryption key and mutation credentials.
Bind the handoff to run/attempt, commit, account/backend/workspace, tool/provider
and configuration selections, and artifact hashes; expire it after one day,
matching encrypted artifact retention. Reruns may produce fresh attempt-specific
handoffs and require approval again; they cannot reuse another attempt's plan.
Unrelated main commits do not invalidate a plan. Reject stale state and
expired/missing/mismatched material.
Apply that plan without replanning, and never rebuild the deployed artifacts.

Hold workflow-wide production concurrency through approval and verification.
Retain health and DB-backed smoke tests and emit exact-run safe reports for the
separate read-only monitor (#28). A plan pass does not establish runtime success.
Additional checks stay limited to HTTPS/access behavior, CloudFront readiness,
API default-endpoint protection and matching Lambda code, with bounded retries
and safe reasons. Terraform outputs supply app URLs, including the web build's API URL.

## Consequences

The operator must provision a separate planning role/token, configure GitHub
protections, and manage the handoff key. The existing broad mutation role is not
reused for planning. Bootstrap is separately authorized, not silently performed
by local preview commands. The workflow fails closed until prerequisites exist.

Self-review supports a sole maintainer but is not four-eyes review. Environment
administrators can change repository policy; these controls are not an agent or
administrator sandbox. Read-only planning still has sensitive state access.
Review can expire or become stale and then requires a fresh run and fresh human
approval. Encryption limits accidental public artifact disclosure but does not
replace short retention, credential isolation or trusted main-branch code.

No automatic rollback or recovery apply is introduced. Partial deployment is a
failed/incomplete result; a revert or repair needs a newly reviewed plan.
