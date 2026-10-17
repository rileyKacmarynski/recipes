# Local implementation–verification loop

`pnpm loop <approved-run-config.json>` runs one explicitly requested local workflow.
It never selects an issue, commits, pushes, deploys, closes issues, creates worktrees,
or changes an acceptance contract. A passing result is **a proposal for human approval**.

## Two ways to work

- **`verify`**: implement together first, then run checks → independent code review →
  independent security review → optional architecture review → artifact production →
  UAT → independent acceptance verification. There is no implementation session,
  agent-applied edit, or automatic repair. Findings return to the human. After repairs,
  start another run with a new evidence directory.
- **`implement`**: one implementation session proposes structured source replacements.
  TypeScript applies only explicitly authorized replacements, then runs the same gates.
  Actionable review/UAT product failures may return to that session for bounded repair.
  Every repair gets fresh reviewers and a fresh candidate/acceptance verifier.

Reviews are adversarial assessments by agents that did not implement the code, not
unrestricted attack-script execution. They can question correctness, abuse paths,
architecture and coverage. Missing executable checks or changed expectations require
human approval, not an agent inventing a new acceptance gate during the run.

Reviews target the approved application/task, not the loop running them. The
coordinator owns authorization and enforcement checks; reviewers do not require loop
source, permission/sandbox probes or approval transcripts to review the application.
Loop internals are review targets only for tasks explicitly changing or auditing them.
Pre-UAT reviewers assess the evidence available at that stage; final build/UAT
coverage is the later acceptance verifier's responsibility.

The final verifier receives the current attempt's full validated review results and
session IDs alongside command outcomes and exact-candidate UAT evidence. `checkPolicy`
explains the existing unit command's named opt-in exclusions: database integration,
runner hardening and recursive loop integration tests, plus the nested sandbox
self-test. These exclusions are not reported as passes. Unexplained skips and any
skipped explicitly required contract check still require human input; every required
UAT scenario must run and pass. A contract requiring an excluded suite needs separate
execution evidence, not a waiver from this policy.

## Prerequisites and invocation

- macOS with working `/usr/bin/sandbox-exec`, Node 24+, and the pinned pnpm dependencies.
  Other platforms fail closed. Seatbelt is a platform dependency, not a portable VM.
- `pnpm install --frozen-lockfile` beforehand. The loop never installs/repairs dependencies;
  pnpm's automatic installation before scripts is disabled in isolated commands.
- A running, authenticated OpenCode V2 **2.0.x** service (`opencode service status`).
  The client is pinned to `@opencode/client` 2.0.32; permission evaluation and failed-idle
  lifecycle handling were exercised against service 2.0.30. It does not start or stop
  the shared service. Select a configured provider/model explicitly. The tested OpenCode
  free-tier model rejected API-driven generation with HTTP 403; there is no fallback.
- The existing [UAT prerequisites](../README.md#local-built-artifact-acceptance-uat):
  Docker Desktop/OrbStack and installed Playwright Chromium.
- A human-approved Markdown contract snapshot and run configuration. Read the issue
  and comments yourself and include their agreed requirements in that snapshot; the
  coordinator does not fetch mutable GitHub requirements or infer authorization.
- No concurrent edits/builds in the same workspace. A loop-owned lock blocks another
  loop, not your editor or unrelated developer processes.

For a verification of the existing recipe contract, create an approved config such as:

```json
{
  "mode": "verify",
  "issue": "#29 / human-approved recipe contract",
  "workspace": "/absolute/path/to/recipes",
  "contract": ".local/loop/approved-recipe-contract.md",
  "evidence": ".local/loop/verification-001",
  "billing": "chatgpt-subscription",
  "models": {
    "implementation": "openai/gpt-6.1-sol#medium",
    "code-review": "openai/gpt-6.1-sol#medium",
    "security-review": "openai/gpt-6.1-sol#medium",
    "architecture-review": "openai/gpt-6.1-sol#medium",
    "verification": "openai/gpt-6-luna#low"
  },
  "contextFiles": ["packages/core/src/index.ts", "packages/api/src/app.ts"],
  "architectureReview": false,
  "scenarios": [
    "fresh application shows an empty recipe state",
    "create a recipe and see it listed",
    "recipe remains visible after reload",
    "reject an empty title without creating a recipe"
  ]
}
```

Set `workspace` to your checkout. These model/variant IDs were checked against the
workspace's ChatGPT OAuth catalog. Use the existing OpenAI connection signed in with
ChatGPT, not an API key. The coordinator checks OAuth-only connection metadata and the
native OpenAI route to `https://chatgpt.com` before session creation and again before
each prompt. A key/environment connection, custom/API endpoint, or changed route stops
setup: there is no paid API/provider fallback. No credentials or provider settings are
changed by this preset. Paths other than the config
argument resolve from `workspace`. The config argument resolves from the current
directory. Run from the checkout containing the coordinator:

```sh
pnpm loop .local/loop/approved-run.json
```

The evidence directory must not exist and must be under `<workspace>/.local/loop/`.
The contract/config must be outside that new directory. Review source includes dirty
tracked source, untracked code, the initial Git diff, and explicit `contextFiles`.
Supply unchanged collaborating modules/tests needed to judge the change. Handoffs over
500 KB stop for human input instead of silently dropping context or evidence.

## Models and cost controls

`model` is an explicitly declared default. Override any role with `models`; alternatively
omit the default and specify every active role. Select catalog IDs available in this
workspace, not provider display names. Strings support `provider/model#variant` (model
IDs may contain `/`); the existing `{ "providerID": "...", "modelID": "..." }` form also
works, with optional `variant`. This is the cost-conscious starting preset checked
against the local catalog on 2026-10-17, not a benchmarked guarantee of review quality:

```json
{
  "billing": "chatgpt-subscription",
  "models": {
    "implementation": "openai/gpt-6.1-sol#medium",
    "code-review": "openai/gpt-6.1-sol#medium",
    "security-review": "openai/gpt-6.1-sol#medium",
    "architecture-review": "openai/gpt-6.1-sol#medium",
    "verification": "openai/gpt-6-luna#low"
  },
  "budget": {
    "maxTotalTokens": 100000,
    "maxInputTokensPerCall": 30000,
    "targetOutputTokensPerCall": 2000,
    "overheadTokensPerCall": 4096
  },
  "maxAttempts": 2,
  "architectureReview": false
}
```

Merge these fields into the complete approved run config. ChatGPT subscription billing
is the default. It permits only `openai/...` selections, including otherwise inactive
role overrides, and requires the OAuth/official-endpoint preflight to pass. Every active
model and variant is checked before the first prompt. Missing API price metadata does
not block a subscription model and is never interpreted as free API usage. There is no
implicit model fallback, premium escalation, or change to tools/permissions by model tier.
Model identities are checked against the server's session responses and recorded in reports.

| Role                    | Subscription model            | Starting policy                                                     |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------- |
| Implementation          | GPT-6.1 Sol, medium reasoning | Capable coder when autonomous implementation is explicitly selected |
| Code review             | GPT-6.1 Sol, medium reasoning | Fresh independent session; the same model can serve different roles |
| Security review         | GPT-6.1 Sol, medium reasoning | Favor review quality without max reasoning by default               |
| Architecture review     | GPT-6.1 Sol, medium reasoning | Optional; disabled by default                                       |
| Acceptance verification | GPT-6 Luna, low reasoning     | Lower reasoning effort for the bounded evidence packet              |

This is a starting preset, not a repo benchmark or a claim about relative subscription
quota multipliers. All roles share the connected ChatGPT plan's limits. Use verify-only
mode after collaborative coding to skip the coder entirely; leave architecture review
off unless needed. No AWS, API-key accounts or additional providers are required.

Subscription reports mark USD reservations, rates and totals as **null/unpriced**, not
`$0`. Token budgets, per-call input limits, deadlines and repair bounds still apply.
`maxEstimatedUsd` is only operative in explicitly selected `billing: "metered"` mode;
that mode is not selected by this preset. Metered mode still requires pricing metadata.
The loop cannot read or exactly predict remaining ChatGPT message/weekly quota or any
plan-specific model weighting, and it never buys credits, changes plans or falls back
to paid API billing when quota/auth fails. Account-level optional credit/auto-recharge
settings are outside this coordinator's control.

Before each prompt, the coordinator reserves estimated input plus the response target
against the remaining run token allowance (and dollar allowance only in metered mode).
Input estimation uses UTF-8 bytes / 3, known implementation-session history and the
configurable system-overhead margin. Metered dollar reservations use the largest catalog
input/cache/output rates across tiers, with no assumed cache discount. This is a heuristic,
not a tokenizer, ChatGPT quota meter or a provider request-bound proof.

After completion (including failed/partial requests when retrievable), cumulative session
counters are reconciled into **deltas**, so reused implementation sessions are not double
charged in the ledger. Input, output, reasoning and cache counters are conservatively
summed; providers may overlap these categories. In metered mode, accounted dollars use
the larger of catalog-estimated usage cost and server-reported cost. Subscription mode
uses tokens and labels dollars unpriced. Unknown/regressing counters stop
further calls instead of being assumed free. Token/dollar overruns produce `budget-exhausted`
before applying an implementation response or accepting a verifier result. Budgets reset
only on a new human-requested run; they are not a daily/account-wide spending limit.

**These are admission/observational controls, not a hard billing cap.** The V2 session
API has no per-prompt output-token limit. `targetOutputTokensPerCall` is a response
target, not an enforced provider option. Hidden reasoning, retries, server instructions,
compaction/warming or inaccurate catalog prices can exceed a reservation before counters
arrive. Use ChatGPT's account usage limits as the quota authority; token estimates are
not a guarantee about remaining plan quota. Provider-side spending limits are the billing
backstop only for explicitly metered API use. No global/project OpenCode config or
credentials are edited here. The connection and routing checks assume a trusted,
unchanged OpenCode service/provider runtime, not a hostile server or concurrent host
configuration changes during a request.

For economy, prefer `verify` after collaborative implementation, leave architecture review
opt-in, and evaluate cheaper roles against known defects before trusting them. Reviewers
receive the unit-test log and command outcomes; successful lint/typecheck/build logs remain
local and are explicitly listed as omitted. Acceptance verification receives its scenario
results, browser log and UAT summary; product failures also include server/migration logs.
Full logs remain retained, with no silent claim that omitted evidence was inspected. The
packet contains each latest writable source only once, plus its initial version for review;
all changed source and the full ADR packet remain supplied. Oversized context stops rather
than silently dropping coverage—split/narrow the approved workspace change if necessary.
Common contract/ADR context is serialized first for potential same-model/provider caching;
different models/providers do not imply a shared cache or automatic savings.

For implementation mode, set `"mode": "implement"` and explicitly authorize, for example:

```json
"writableFiles": ["packages/core/src/index.ts", "packages/api/src/app.ts"]
```

Only existing regular, non-hardlinked, non-symlink `.ts`, `.tsx` or `.css` files under
web/API/core `src/` may be authorized. Tests, generated files, database migrations,
configuration, orchestration, infrastructure, and new/deleted files are not repair
targets in this first version. Work requiring those changes returns to the human.
`verify` rejects any nonempty `writableFiles` authorization.

## Ownership and enforcement

| Owner                                                | Responsibility                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                           | Explicit transitions, schema validation, session ownership, gates, command execution, retry/deadline limits and reports                |
| Agent role instructions / existing preference skills | Implementation judgment, adversarial review, evidence interpretation, actionable findings and uncertainty                              |
| OpenCode session permissions                         | Deny **all** tools for every role, including edits, shell, subagents, Code Mode and plugin/MCP actions                                 |
| Narrow edit interface                                | Validate all proposed file replacements before applying any; reject unauthorized paths, aliases, duplicate edits and protected targets |
| macOS sandbox                                        | Restrict the filesystem, networking, process control and IPC of candidate-controlled command/runtime processes and their descendants   |
| Existing producer/UAT                                | Build/manifest rules; disposable database, migrations, serving, browser journeys, evidence and runtime teardown                        |

There is no skill per state. Each pre-UAT adversary has a focused judgment skill:

- `code-review` role: `.agents/skills/adversarial-code-review/SKILL.md` and the
  shared `.agents/skills/code-review/REVIEW-GUIDANCE.md`. The interactive `code-review`
  skill reuses that same Standards/Spec methodology; its subagent-scheduling procedure
  is not loaded into the loop.
- `security-review` role: `.agents/skills/security-review/SKILL.md`.
- `architecture-review` role: `.agents/skills/architecture-review/SKILL.md`, with
  the existing `architecture-preferences` and `codebase-design` skills.

TypeScript loads the fixed skill/reference files plus all numbered `doc/adr/` records
before agent execution, protects their hashes and canonical targets, and retains their
contents in `context.json`. Each reviewer gets its own skill/reference contents, the
full ADR packet (including supersession/status text), source/evidence and a JSON Schema
derived from the validated verdict contract. Missing/empty guidance stops setup; there
is no generic-prompt fallback. Findings cite applicable current ADR decisions rather
than imposing superseded requirements. Skills stay available for human-invoked reviews
too; loop agents need no tool access to discover/read them.

Architecture/testing skills and relevant frontend/accessibility skills are also
supplied as implementation/review context. Thin handoff instructions and exact
packets are retained. No skill schedules work, grants a permission, or converts a
machine failure to success.

Before any prompt, a write/link/descendant/nested-sandbox/process-group/signal/network probe must
pass. Every new session then exercises OpenCode's permission evaluator for built-in
and unknown actions; anything other than `deny` stops execution. A prompt being
accepted is not completion: the client waits for idle, checks the session outcome,
correlates the current prompt, rejects failed/incomplete/tool-executing responses,
and parses only that response's JSON. Old successful messages are never reused.

Implementation agents cannot directly touch the workspace: they return replacements
through the validated interface. Reviewers/verifiers return findings only; TypeScript
writes their designated evidence/report files. They cannot invoke build, repair,
deployment or arbitrary shell actions. The approved contract and all repository
inputs except explicitly writable application source/generated product output are
snapshotted. Hashes detect external changes; **the edit interface and OS sandbox—not
those hashes—prevent loop-owned changes to protected inputs**.

Check/build processes receive a sanitized environment, no network, and writes only to
their scratch area and enumerated product/compiler output directories. Dependency
code, verification tools, source, and prior attempts are not writable. Workspace
`.git`, `.local` (except owned writable scratch/candidate output), and root environment
files are hidden from these processes. Candidate API/migration bundles have read-only
artifacts, isolated scratch, and outbound TCP access only to that run's local database
port. The API can bind loopback listeners. Unix sockets, unrelated outbound endpoints,
cross-process control, Mach/other IPC and Apple Events are denied; descendants inherit
the restrictions. Seatbelt profile version 3 forces `posix_spawn` to return `ENOSYS`
(requiring fork/exec) and denies `setsid`/`setpgid`, so detached descendants cannot
escape the process group owned by teardown. This is probed, not assumed from a shell
allowlist. Writable sandbox roots containing symlinks are refused.

The trusted UAT launcher stays outside that sandbox because it owns Docker/browser
provisioning. Its API/migration child-launch seam opts into isolation using
`UAT_SANDBOX=1` and a new `UAT_SANDBOX_SCRATCH` directory. Ordinary `pnpm uat` retains
ADR 0007's trusted-artifact behavior; it is **not** independently a hostile-code sandbox.
Browser JavaScript is governed by browser origin/security rules, not an agent tool.

### Limits of the security claim

Trust the host OS/kernel, Node/browser/toolchain/dependencies, installed OpenCode
service/plugins/configuration, and the human operating the workspace. Permissions do
not sandbox arbitrary installed plugin code. This is not isolation against a hostile
host administrator, compromised dependency, native/browser exploit, filesystem racing
by another host process, or resource-exhaustion attacks. Do not provide production
credentials or run unrelated developer resources inside the loop's scratch/output
directories. Evidence can contain private source, paths, logs and model error bodies;
it is local/ignored, owner-directory protected, and must not be uploaded blindly.

If the sandbox or permission probes fail, diagnose them; do not disable the checks,
grant shell access, broaden writable roots, or substitute a checksum-only mode.

## Gates, failures and limits

The coordinator directly invokes `lint`, `typecheck`, `test:unit`, `build:uat`, and the
existing UAT runner (its Node entrypoint, so cancellation reaches the teardown owner).
There is no agent-selected command or duplicate database/browser orchestration.
Every required command must exit zero, every approved scenario must be present and
pass with actual test-result evidence, cleanup must succeed, and every required
review plus the acceptance verifier must approve. A narrative cannot override a
failed, skipped, missing or mismatched machine result.

- UAT `setup-error`, command-launch failures or malformed/incomplete machine evidence:
  stop for diagnosis, without application repair.
- Existing ordinary check commands do not expose structured product/setup attribution.
  Their unattributed nonzero exit stops for human diagnosis rather than guessing that
  an environment failure authorizes a rewrite. Build failures likewise stop.
- Actionable in-contract product findings or UAT expectation failures: bounded repair
  in `implement`; report and stop in `verify`.
- Missing/malformed agent JSON, failed sessions, reused independent-session IDs, or
  executed tools: agent/protocol failure. Ambiguity, coverage gaps and proposed spec
  changes: verifier uncertainty or human input. Protected-input mutation: stop.

Defaults: **2 attempts** (one repair) in implementation mode (maximum configurable 5), **one** in
verify-only mode; **30 minutes** overall work; **5 minutes** per agent call and command.
Configure `maxAttempts`, `wallClockMs`, `agentTimeoutMs`, and `commandTimeoutMs` in JSON.
The overall maximum is one hour; per-call maxima are 15 minutes. Repeated identical
findings/failed expectations stop early. A repair never falls back to an earlier
passing artifact or report. Attempts rejected before build have no candidate.

SIGINT/SIGTERM stops new work and interrupts only owned session IDs. Queued owned
prompts and permission requests are canceled/rejected; idle completion is confirmed.
The shared service and unrelated sessions are never stopped. Owned check/build process
groups are terminated (3-second grace). UAT gets SIGTERM and retains teardown ownership,
with a 90-second cleanup allowance before its own launcher PID is killed. Agent cleanup
allows 10 seconds per owned session. These cleanup allowances are outside the work
deadline. A stuck Docker/host or SIGKILL cannot guarantee teardown: incomplete cleanup
is reported, cannot pass, and retains the workspace lock for diagnosis. Do not remove
a stale lock until you have inspected its PID/evidence and owned resources.

## Evidence and validation

Each run retains `report.md`, `report.json`, approved `contract.md`/hash, config,
protected-input hashes, source/instruction snapshots, session IDs, isolation probes and
`agent-usage.json`. Model/variant selections, per-attempt call reservations, observed token
categories, estimated/reported cost and unknown accounting are included in final reports.
Catalog settings/headers/provider credential bodies are excluded from cost evidence.
Each attempt retains timestamps, outcomes, agent input/output/error transcripts,
review session IDs/findings, repair rationale, command logs/results, a unique `artifacts/`
directory with SHA-256 identity, and the existing `uat/` evidence. Intermediate reports
are checkpointed; the final report identifies the current attempt's candidate only.
Invalid configurations or an unwritable/reused evidence directory fail without
pointing at an older report as if it belonged to this invocation.

```sh
# Controlled coordinator/lifecycle/permission tests; no Docker or model request.
pnpm test:loop

# Opt-in: controlled agent handoffs, REAL sandboxed checks/build/browser UAT,
# plus a supplied hostile migration fixture that cannot alter owned protected inputs.
LOOP_TEST_RUNTIME=1 node --test --test-name-pattern='real isolated checks' scripts/local-loop.test.ts

# Opt-in full agent-backed exercise: approve the existing recipe contract/config,
# use mode "verify", a supported explicit provider/model and a NEW evidence path.
pnpm loop .local/loop/approved-run.json
```

For a repair exercise, separately approve implementation mode with a narrow existing
source target and a known product defect. Verify that attempt identities/evidence and
reviewer sessions differ while the implementation session stays the same. Never edit
acceptance expectations to manufacture a green run.

## Open overlap (#25–27)

Inspected all three issues and their comments (none) alongside #24's completion
comment. #25's delivery is present. #26's validation and repeated fresh-state coverage
are present; the rejection scenario asserts no added recipe in the explicitly ordered
existing-record state rather than requiring an empty database. #27's main evidence/
teardown work is present; explicit unavailable-container-runtime regression coverage
and a clean acceptance run _after_ injected failures remain gaps in its runner suite.
Those issues remain open; this workflow does not close them or claim their checklists
were independently re-approved.

See [ADR 0008](../doc/adr/0008-bound-local-agent-work-with-tool-denial-and-process-isolation.md).
