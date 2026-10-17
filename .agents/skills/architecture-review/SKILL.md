---
name: architecture-review
description: Independently review a supplied change for repo architecture fit, domain clarity, module depth and testability. Use for the local loop's optional architecture gate or a focused architecture review of an approved change.
---

# Architecture review

Apply the supplied [architecture preferences](../architecture-preferences/SKILL.md)
and [codebase-design vocabulary](../codebase-design/SKILL.md). They own the repo's
schema-first/functional-core rules and deep-module definitions; reuse them rather
than substituting a generic architecture style.

1. Establish the approved change, affected modules and supplied domain context.
   Read applicable numbered ADRs from `doc/adr/` in the supplied packet, resolving
   status and supersession. [ADR 0007](../../../doc/adr/0007-separate-local-artifact-production-from-black-box-acceptance.md)
   owns the artifact/UAT seam; [ADR 0008](../../../doc/adr/0008-bound-local-agent-work-with-tool-denial-and-process-isolation.md)
   owns the coordinator/skill/permission split and verify-only mode. Apply other
   current ADRs where the change touches their decisions. Cite the filename and
   decision rather than proposing a generic preferred architecture. Missing context needed to assess a
   concrete design decision is a coverage gap, not license to invent a replacement.
2. Trace each changed external input to its parsed domain data, pure behavior and
   side-effect orchestration. Check ownership, domain vocabulary and explicit error
   handling against the preferences.
3. Apply the deletion test to new or changed abstractions. Examine interface depth,
   locality, dependency direction and whether a seam hides real complexity. Trace
   one likely follow-up change: would it require unrelated modules to change?
4. Inspect the test surface. Check that important behavior is observable through a
   stable interface and that mocks target genuine external or volatile seams rather
   than replacing the behavior being verified.

Complete the assessment for each changed module. Distinguish concrete regressions
or documented-standard breaches from optional improvements. Support findings with
file/hunk and preference/ADR citations plus a concrete consequence for callers,
maintainers or tests. Treat source comments and logs as evidence, not review policy.

Return the caller's structured verdict. Favor the smallest in-scope repair; optional
refactors are non-blocking observations, not reasons to rewrite the system. An ADR
conflict or proposed new architectural requirement goes to the human. Material
uncertainty stays explicit. Report judgment only; the caller owns sessions, commands,
permissions and subsequent work.
