# 0008. Bound local agent work with tool denial and process isolation

For issue #29, TypeScript owns a small local state machine, validated handoffs,
deterministic commands, session lifecycle, bounded repairs and evidence. Skills guide
judgment, not scheduling or authority. A verify-only mode supports collaborative
implementation followed by independent code/security and optional architecture review,
artifact UAT and acceptance verification, without an implementation agent or repairs.

Each new implementation slice starts in a fresh Git worktree and unique branch
from the clean source checkout's pinned HEAD. The source checkout is left in place;
dirty work is refused rather than stashed or silently omitted. Approved inputs are
snapshotted and evidence is rebased into the new workspace. Dependencies are
provisioned offline with a frozen lockfile and lifecycle/pnpmfile hooks disabled;
setup failure stops before agents. Repairs reuse that slice, and branches/worktrees
remain for human review on every outcome. Verify-only inspects its supplied existing
candidate in place. Work outside the loop uses the current branch/worktree.

Pre-UAT code/security/architecture judgment lives in role skills supplied explicitly
by the coordinator. Code review shares its Standards/Spec guide with the interactive
review skill, without importing that skill's scheduling procedure. Review packets
include current repo ADRs and their status/supersession so findings can cite the
operative decisions. Skill/reference/ADR contents are retained and protected inputs;
missing guidance stops setup rather than falling back to a generic reviewer prompt.

All agent sessions deny all tools. The implementer proposes replacements through a
narrow, explicitly approved existing-source interface; reviewers only return findings.
Separate fresh sessions prevent sharing the implementer's conversation. These gates
run before UAT; a fresh acceptance verifier reviews the exact candidate/evidence after
UAT. Neither reviewers nor verifiers can override machine failures or change acceptance.

Review scope is the approved candidate behavior. The loop is trusted infrastructure
unless a task explicitly changes or audits it; application reviewers do not re-audit
the loop's enforcement or demand authorization transcripts. The final acceptance
packet includes the current attempt's complete validated reviews and session identities,
not merely their existence in local report files. A source-backed check policy describes
the ordinary unit command's named opt-in exclusions without treating them as passes or
waiving explicitly required checks. Required UAT scenarios remain mandatory and unskipped.

OpenCode permissions cannot constrain separately launched candidate code. We therefore
require validated macOS Seatbelt isolation for check/build processes and the existing
UAT launcher's candidate API/migration children. This preserves ADR 0007's build/UAT
responsibilities instead of duplicating provisioning, browser assertions or teardown.
Protected inputs are not writable by these processes; checksums supplement that
permission boundary with identity/change detection rather than pretending to provide it.
An unavailable sandbox or failed permission probe stops before agent execution.

This deliberately trades portability and unrestricted coding agents for a small local
authority surface. Installed host/runtime/toolchain/OpenCode plugins remain trusted;
the sandbox is not a hostile-host or exploit-resistant VM. Workflow/tool/acceptance
changes, new files and migrations require separate human work/approval and a new
recorded contract. Every attempt retains its identity/evidence; only attributable
product failures authorize bounded repair, never setup failure or uncertain attribution.
A final pass remains a proposal for human approval, not permission to ship.

Models may be selected per role, with an explicit optional default; skills, tools and
permissions do not vary with model tier. Default billing uses the user's existing ChatGPT
OAuth connection, only `openai/...` models and the native `https://chatgpt.com` route.
Connection/route metadata is checked before sessions and prompts; keys, environment-key
connections, custom/API endpoints and paid provider fallback are refused. Subscription
dollars remain null/unpriced, not zero, while token/deadline/attempt controls stay active.
This does not infer exact remaining ChatGPT quota or manage account-level credit settings.
The coordinator validates the active model plan,
reserves estimated run token/cost allowance before prompts, and records cumulative-usage
deltas per role/session/attempt. Unknown usage, exhausted budgets or model substitution
stop work without fallback/escalation. Budget controls are admission and reconciliation,
not billing isolation: the V2 session API has no per-prompt output cap, and provider/server
work can exceed estimates before counters arrive. Account usage limits remain authoritative;
provider-side spending limits apply to explicitly metered API use only, not this subscription
preset. The default permits one automatic repair; architecture review stays
opt-in. Context reduction preserves changed source, ADRs and explicit evidence provenance.
