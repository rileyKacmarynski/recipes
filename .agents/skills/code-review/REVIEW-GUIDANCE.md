# Code review judgment

Use the approved comparison, spec, source, evidence and repo standards supplied by
the caller. This guide defines judgment; the caller owns context gathering,
independent sessions, execution and output format.

## Standards axis

Treat applicable current repo ADRs under `doc/adr/` as standards alongside the repo
instructions/preferences. Resolve each ADR's status and supersession before applying
it. Cite the ADR filename and decision for a conflict; changing an accepted decision
is a proposal for human approval, not an automatic repair. In the local loop,
[ADR 0007](../../../doc/adr/0007-separate-local-artifact-production-from-black-box-acceptance.md)
owns the artifact/UAT seam and
[ADR 0008](../../../doc/adr/0008-bound-local-agent-work-with-tool-denial-and-process-isolation.md)
owns the coordinator/skill/permission split. Use their supplied contents; missing
relevant ADR context is an explicit gap.

For each changed module, identify breaches of the supplied documented standards.
Cite the standard's file/rule and the relevant file/hunk. Distinguish a documented
violation from a design judgment. Leave mechanically enforced formatting/lint rules
to tooling; green tooling is not evidence of correct behavior.

Apply the Fowler smell baseline below as a set of heuristics, not mandatory refactors.
Repo standards override the baseline. A smell needs a concrete maintenance or
correctness cost in this change; name it as a possibility, not a hard violation.

- **Mysterious Name**: a name obscures what it holds or does. Suggest a clearer name;
  if none fits, explain the underlying ambiguity.
- **Duplicated Code**: repeated logic encodes the same decision. Identify a shared
  home for that decision rather than merging merely similar syntax.
- **Feature Envy**: behavior navigates another module's data more than its own.
  Consider moving the behavior to the module owning the knowledge.
- **Data Clumps**: the same fields travel together. Consider a named schema/type
  when they represent one concept.
- **Primitive Obsession**: a primitive hides meaningful domain constraints.
  Consider a domain schema/type rather than a wrapper without behavior or invariants.
- **Repeated Switches**: the same branching decision appears in several places.
  Consider centralizing the decision or an appropriate polymorphic design.
- **Shotgun Surgery**: one logical change requires scattered edits. Identify where
  the changing knowledge belongs together.
- **Divergent Change**: one module changes for unrelated reasons. Suggest a split
  only where those reasons have genuinely different ownership.
- **Speculative Generality**: abstractions serve requirements the spec does not have.
  Prefer the smallest implementation meeting the approved need.
- **Message Chains**: callers depend on a long navigation path. Consider hiding the
  walk behind an interface that owns the knowledge.
- **Middle Man**: a module mostly forwards calls without hiding useful complexity.
  Consider removing the forwarding layer.
- **Refused Bequest**: an implementation discards most of an inherited contract.
  Consider composition or a more honest interface.

Completion: every changed module has been assessed against applicable standards and
these heuristics; report concrete findings, not a list of hypothetical refactors.

## Spec axis

Map each approved requirement to implementation and meaningful evidence. Check:

1. Missing or partial requirements, including error paths and boundary inputs.
2. Implemented behavior that contradicts the requirement despite green checks.
3. Unrequested behavior or scope expansion.
4. Tests that pass without exercising the claimed behavior: mocks replacing the
   behavior under review, assertions disconnected from outcomes, omitted cases, or
   a changed expectation masking a regression.

Trace plausible counterexamples through the supplied source. For each defect, cite
the requirement and file/hunk, explain the triggering input/path and observable
consequence, and state what evidence would confirm a repair. Label an unexecuted
counterexample as source reasoning, not a reproduced test failure.

Completion: every approved requirement is accounted for as supported, defective or
unresolved. Missing source/spec/evidence is an explicit coverage gap, not approval.

## Findings and conclusion

Keep **Standards** and **Spec** findings separate so one axis cannot mask the other.
If the caller's schema has one findings array, prefix each item with its axis.
Prioritize concrete, actionable defects and clearly label judgment calls. Tie repair
advice to the approved scope; changed requirements or unresolved evidence return to
the human. Respect failed machine checks regardless of the narrative conclusion.
