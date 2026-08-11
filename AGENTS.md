# Project Guidelines

## Philosophy

Keep solutions simple.

Prefer composition over abstraction.

Avoid introducing infrastructure before it is needed.

Keep pull requests and commits small.

## Architecture

- React SPA
- Hono API
- TypeScript is the primary application language.
- Python is only used for extraction and ML tasks.
- Business logic belongs in TypeScript.
- Python should avoid direct ownership of application state.

## Development

When implementing a feature:

1. Keep changes focused.
2. Reuse existing patterns.
3. Avoid unnecessary dependencies.
4. Ask before introducing new frameworks.
