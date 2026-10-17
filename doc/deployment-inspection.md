# Read-only production deployment inspection

`pnpm deploy:inspect` observes the existing production workflow. It is independent
of `pnpm loop` and local UAT. It never repairs source or expectations, accesses
AWS/Cloudflare, dispatches/reruns Actions, approves environments, or changes GitHub.

## Operator workflow

1. Finish and review the change locally or in a PR.
2. **Separately authorize** push/merge to `main`, or explicitly dispatch the existing
   workflow on `main`, under [ADR 0006](adr/0006-apply-actions-plans-automatically-after-source-review.md).
   Inspection does not perform or authorize this step.
3. Inspect the exact full commit SHA and workflow in an explicit repository:

   ```sh
   pnpm deploy:inspect --repo rileyKacmarynski/recipes \
     --workflow .github/workflows/deploy.yml \
     --commit 8a3fff85dfb22865882312230c9920651e97a538 \
     --run 39071880908 --attempt 1
   ```

   `--run` is optional when exactly one run matches. Workflow identity is the
   explicit path above or its numeric GitHub workflow ID; names like `Deploy`,
   branch names, abbreviated SHAs and unqualified "latest" are not accepted.

4. Share `summary.md` and sanitized JSON reports. Report failure or uncertainty
   without making repairs. Any recovery, rerun, dispatch or deployment is a
   separate human decision under the production runbook.

Requirements: Node 24+, installed repo dependencies, `gh` authenticated for Actions
read access to the repository, and `unzip` on PATH. Tests also use `zip`. No
production credentials or write permissions are needed. Run from the repo root.
The GitHub CLI/configuration and host toolchain are trusted; this is not a sandbox.

## Selection, waiting and attempts

Repository, numeric workflow identity, workflow path, SHA and optional run ID are
cross-checked against GitHub. All collections are paginated (at most 100 pages).
Multiple runs for one commit fail with candidate IDs, never a guessed winner.
An explicit not-yet-registered run (404) or absent discovery match waits, bounded
by `--discovery-seconds` (default 60, maximum 3600).

Completion waits up to `--wait-seconds` (default 900, maximum 7200), polling every
`--poll-seconds` (default 5, maximum 60). Queued, approval-waiting, running and
terminal states are distinguished. Native pending environment approvals are
observed through GET only; waiting for approval is not deployment failure.
The timeout outcome preserves that pending state and is never success.

Attempt 1 may be inferred. Reruns require **both** `--run` and `--attempt` explicitly.
Without an explicit attempt, an attempt change during waiting/collection stops
inspection. Explicit historical attempts are supported and labeled with the
latest observed attempt; success means that selected attempt, not a claim that
it is the latest deployment. The attempt-specific jobs endpoint is used; missing
jobs in a partial rerun are not silently borrowed from an earlier attempt.

Each `gh` GET is bounded by the remaining phase deadline and at most 30 seconds.
Evidence collection has a separate 120-second window. ZIP inspection subprocesses
have 10-second limits and bounded buffers. Network/authentication/schema errors
stop with safe messages, not raw provider/CLI diagnostics.

## Success contract

The schema-version-1 contract comes from `.github/workflows/deploy.yml`, #14 and
the production runbook, not the local agent loop:

- Exactly one successful, completed `Non-E2E Checks`,
  `Plan And Deploy Infrastructure And App Artifacts`, and `Durable Run Result` job.
- Required non-E2E lint, formatting, typecheck, migration checks, unit tests and
  build steps, plus durable overall result recording/upload, must also complete.
- Successful initialization, API build, authoritative saved-plan/policy + matching
  web build, exact-plan apply, outputs, database readiness, migrations, Lambda/web
  rollout, CloudFront invalidation, direct Lambda `/health`, authenticated DB-backed
  `/recipes`, infrastructure verification, durable verification and evidence upload.
- Three exact-run/attempt reports: authoritative passing policy and manifest,
  deployment verification, and durable overall result. Verify provenance, required
  outcome sets, success-flag consistency, and matching saved-plan SHA-256.
- All five infrastructure checks: CloudFront readiness, web/API HTTPS access,
  API Gateway default-endpoint protection, and exact Lambda code.

A green overall conclusion is insufficient. Missing, duplicate, skipped, cancelled,
failed or still-running required jobs/steps, missing checks, and unavailable or
invalid evidence cannot pass. Empty or exclusively `no-op`/`read` resource actions
are an expected **no-change** plan. Under the current workflow, apply, application
deployment and verification **still must execute**; no-change never excuses a skip.
This classification describes sanitized resource actions; the report contract
does not expose Terraform's detailed exit code or output-only changes.
This is observation of Actions evidence, not a new live test or proof of safety.

## Evidence and machine interface

Each invocation retains fresh private reports under the ignored directory:

```text
.local/deployment-inspections/<owner>/<repo>/<commit>/
  run-<id>-attempt-<attempt>/inspection-<unique>/
    result.json
    summary.md
    plan-report.json
    deployment-verification.json
    deployment-result.json
    job-<id>-restricted.log   # Only relevant failed jobs; not safe to share
```

Unselected discovery failures retain reports under `discovery-<unique>` instead.
Repeated inspection never overwrites prior evidence. Directories are private
(0700), files are private (0600), and evidence stays out of source control.

Only the designated `plan-report-<id>-<attempt>`,
`deployment-verification-<id>-<attempt>`, and `deployment-result-<id>-<attempt>`
artifacts are downloaded, with size limits. Archives with unexpected members are
rejected; no archive paths are extracted. Required JSON is parsed and projected
into controlled fields. Downloaded Markdown, arbitrary labels, provider details,
resource/file labels and unknown JSON fields are not copied into shared reports.
Temporary ZIPs are removed even on validation failure. Abrupt process termination
can leave a private ZIP; treat it as restricted until deleted or inspected privately.
Raw binary plans, plan/state JSON, outputs, credentials, JWTs and production recipe
contents are never requested as verification evidence.

Failed-job logs are **restricted diagnostic material**, not sanitized evidence,
even if GitHub masks secrets. They are never printed or embedded in reports.
Missing/expired artifacts, invalid reports and unavailable logs are recorded
explicitly. Actions retains safe artifacts for 14 days; an old green run without
its reports is unverifiable, not a success. Do not upload entire evidence folders
or pass restricted logs to an agent. Review logs privately before sharing anything.

For a machine consumer, use clean JSON stdout:

```sh
pnpm --silent deploy:inspect --repo OWNER/REPO --workflow .github/workflows/deploy.yml \
  --commit FULL_SHA --run RUN_ID --attempt ATTEMPT --json
```

`result.json` and `--json` have the same versioned shape (`schemaVersion: 1`):
`selection`, `outcome`, `state`, `run` (including URL/ID/attempt/latest observed
attempt/workflow/SHA/conclusion), `candidates`, required `jobs` and `checks`,
`evidence` availability/relative paths, `plan`, `problems`, and `directory`.
Consumers should reject unsupported schema versions and require
`outcome === "success"`, not merely `run.conclusion === "success"`.

| Exit | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| 0    | Selected attempt and complete required evidence verified successfully                                    |
| 1    | Deployment failed/cancelled/timed out, inspection wait timed out, or checks/evidence incomplete          |
| 2    | Invalid inputs, ambiguous selection, unselected/changed attempt, GitHub/parse/prerequisite/storage error |

Once valid inputs/local storage are available, selection/inspection errors also
produce human/machine reports. Argument/setup failures before that point print
only a safe stderr diagnostic and exit 2 (no JSON result is promised).

Controlled tests: `node --test scripts/inspect-deployment.test.ts`. These use fake
GitHub responses, a fake `gh` executable, and local archives; no production
credentials, deployments, reruns, approvals or network calls are needed.
