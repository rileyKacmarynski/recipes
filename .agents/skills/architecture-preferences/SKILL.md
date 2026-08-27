---
name: architecture-preferences
description: Repo-specific implementation preferences. Use when designing or implementing application/domain code, choosing module boundaries, handling external data, or reviewing whether code matches the user's DDD, schema-first, functional-core preferences.
---

# Architecture Preferences

Use this with `domain-modeling` and `codebase-design`. `domain-modeling` sharpens the language; `codebase-design` sharpens the seam; this skill decides how those ideas should become code in this repo.

## Default Shape

Default to **schema-first functional core** until complexity proves it needs more structure.

- Model domain data with Zod schemas and exported inferred TypeScript types.
- Keep data shapes and behavior separate: data is plain data, behavior is functions over parsed data.
- Prefer pure domain functions that accept explicit inputs and return values.
- Put orchestration in application/API/UI layers, not in domain data objects.
- Introduce richer modules, use cases, or adapters only when they increase depth, locality, or testability.

## Hard Rules

- Parse untrusted data at every trust boundary before treating it as domain data.
- Trust boundaries include third-party API responses, request bodies, URL/search params, storage, generated JSON, DOM-derived values, and anything crossing process/package boundaries without a typed guarantee.
- Domain functions receive parsed domain types, not `unknown`, raw API payloads, DOM values, or loosely typed records.
- Keep validation/parsing errors explicit enough for callers to handle deliberately.

## Defaults With Escape Hatches

- Start with schemas and functions in the smallest existing package that owns the concept, usually `@recipes/core` for shared domain concepts.
- Add a use-case module when a workflow coordinates multiple domain functions, adapters, or side effects.
- Add an adapter seam when there are at least two real implementations or one implementation is volatile enough that isolating it buys locality.
- Add factories or constructors when invariants cannot be represented clearly by a schema plus named function.
- Avoid rich mutable entities by default; use them only when identity, lifecycle, and invariant protection are central enough to justify the surface area.

## Review Checklist

- Does the code use the project glossary and domain terms consistently?
- Is every external or weakly typed input parsed before entering the domain core?
- Are schemas, domain types, and domain functions close to the concept they describe?
- Are functions named after domain behavior rather than technical mechanics?
- Is orchestration separated from domain calculation?
- Did the change avoid speculative seams, generic services, and pass-through wrappers?
- Are tests written at public seams and focused on behavior rather than implementation?

## When Preferences Conflict

If a simple data/function design feels awkward, do not immediately introduce objects or a framework pattern. First try clearer names, a deeper module interface, or a small use-case function. If the richer design still wins, explain the pressure that made it worth the extra structure.
