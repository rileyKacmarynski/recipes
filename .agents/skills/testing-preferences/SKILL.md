---
name: testing-preferences
description: Repo-specific testing preferences. Use when adding or reviewing Vitest, Playwright, API, domain, component, regression, fixture, mock, or coverage choices.
---

# Testing Preferences

Tests should create confidence, not volume. Prefer tests that explain what the system does, survive refactors, and protect meaningful behavior at stable seams.

## Priorities

Use this priority order when trade-offs appear:

1. Refactor confidence.
2. Design pressure toward better seams and simpler interfaces.
3. Regression capture.
4. Documentation of expected behavior.

## Test Surface

- Test public behavior through stable seams: package exports, API routes, user-visible UI, workflows, and meaningful module interfaces.
- The unit under test may be broad. A unit can be a pure function, a domain module, an API route, a component with real behavior, or a package-level seam.
- Avoid tests that only prove internal wiring or one tiny implementation detail works.
- Use more tests where business risk, parsing, state complexity, or bug history is high; use fewer where behavior is obvious.

## Vitest Role

Vitest is for fast unit/behavior/regression tests. It should provide confidence that the system has fewer bugs, without implying every component or helper needs isolated tests.

- Focus on core domain invariants, schemas, validation, edge cases, API route behavior, and bug reproductions.
- For API tests, prefer `app.request(...)`: request in, response out.
- Assert HTTP status, response body, important domain result/effect, and useful error shape for invalid requests.
- Avoid calling route handlers directly when the app-level seam is available.

## Playwright Role

Playwright is for system confidence and product judgment.

- Cover critical happy paths and major user journeys.
- Include important failure, empty, validation, and error states when they affect the user journey.
- Use headed/UI mode as an interactive product harness for evaluating flow and design feel.
- Prefer scenario-style tests that can drive the app into meaningful states.
- Avoid screenshot baselines by default; add visual regression only when it solves a real problem.
- Avoid broad cross-browser/device matrices until the product has risk that justifies them.

## UI And Component Tests

- Test user-observable behavior: roles, labels, text, interactions, and accessible states.
- Include keyboard-path coverage for important custom interactions.
- Component tests are worthwhile for non-trivial behavior, regressions, reused behavior, forms, state transitions, async behavior, and accessibility-sensitive controls.
- Do not add component tests for purely presentational components unless semantics are critical.

## Mocking And Fakes

- Mock external systems and intentionally designed architectural seams.
- Prefer fakes or in-memory adapters when they make assertions more realistic.
- Prefer asserting returned data, response bodies, rendered UI, or seam-level effects over asserting that a mock was called.
- Assert interactions with mocks only when the interaction itself is the behavior under test.
- Avoid mocking internal collaborators just to isolate tiny implementation units.

## Schemas And Boundaries

External boundary schemas deserve strong tests because JavaScript inputs are hostile by default.

- Test known-valid payloads parsing into expected domain shape.
- Test meaningful invalid cases: missing required fields, wrong primitive types, unknown enum values, malformed nested data, empty strings, whitespace, empty arrays, and out-of-range values when the domain cares.
- Test unknown-key behavior when it matters whether schemas strip, reject, or preserve extra fields.
- Do not test Zod internals. Test the repo's schema decisions and domain boundary behavior.

## Test Names

- Prefer readable behavior-focused names.
- Domain tests use domain language.
- UI tests describe user-observable behavior.
- API tests can include protocol details when status codes or response shapes are the behavior.
- Avoid rigid `unitUnderTest_action_expectation` names unless they are clearly more readable in context.

## Test Structure

- Use compact tests when the flow is obvious.
- Use blank-line arrange/act/assert structure when it improves scanability.
- Avoid repetitive `Arrange`, `Act`, `Assert` comments unless the test is dense enough to need signposts.
- Expected values should come from literals, examples, specs, or fixtures, not by recomputing production logic in the assertion.

## Test Data

- Prefer explicit test data for properties that matter to the behavior.
- Use valid-default factories with explicit overrides when setup repeats or noisy objects hide the point.
- Do not create factory infrastructure for tiny types where inline literals are clearer.
- Keep factories in the test file first; move to package-local helpers when multiple files need them.

## Coverage

Use coverage as a smell detector, not a target. Low coverage can reveal missed risk, but high coverage does not prove the tests are meaningful.

## Rewrite Bad Tests

Rewrite rather than preserve tests that pass by construction, couple to implementation details, fail without explaining the broken behavior, or bury the point under noisy setup.
