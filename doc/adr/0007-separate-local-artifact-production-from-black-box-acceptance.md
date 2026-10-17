# 0007. Separate local artifact production from black-box acceptance

Date: 2026-10-17

## Status

Accepted

## Context

Mocked browser tests and separate persistence tests do not prove that the assembled
application works. Local verification must test a supplied build without silently
rebuilding or repairing it, and leave evidence usable by an independent verifier.

## Decision

`build:uat` produces a handoff directory containing static frontend assets, bundled
Node API and migration executables, matching Drizzle migrations, and a SHA-256 file
manifest. The frontend uses a relative `/api` URL so isolated runtime ports do not
require rebuilding. A static server forwards `/api/*` to the supplied API process.

`uat` consumes this directory explicitly and checks its contents before and after
verification. It never builds or substitutes artifacts. The launcher owns fresh
Testcontainers Postgres, supplied migrations, ephemeral listening ports, readiness,
browser execution, logs, and teardown. Acceptance scenarios only use Playwright and
public browser UI: no application imports, database assertions, or intercepted API
responses. Existing fast and mocked browser tests retain their separate purpose.

## Consequences

Each run retains human/machine-readable outcomes, artifact identity, scenario
results, cleanup outcomes, server logs, and failure screenshots/traces outside the
disposable runtime. Setup errors and product expectation failures are distinct,
and both exit nonzero. Ports are allocated by binding to port zero; existing dev
servers and the developer's database are never adopted.

This is a local Node/Postgres fidelity boundary using the existing development
identity, even though application code is built. It does not verify Cloudflare
authentication or AWS/Data API behavior. Docker and an installed Chromium browser
are explicit UAT prerequisites, not requirements for ordinary non-DB tests. No CI,
deployment, artifact registry, or verification-agent orchestration is introduced.
