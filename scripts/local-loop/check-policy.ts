// Scope of the existing deterministic commands, not permission to waive contract requirements.
export function checkPolicy(requiredUatScenarios: string[]) {
  return {
    requiredCommands: ['lint', 'typecheck', 'test:unit', 'build:uat', 'uat'],
    requiredUatScenarios,
    uat: 'Every required scenario must execute and pass against the exact candidate. Missing, skipped, interrupted or incomplete required UAT is never permitted.',
    unitTests: {
      command: 'pnpm test:unit',
      scope:
        'Fast regression checks; not the opt-in database, runner-hardening or recursive loop integration suites. Command success does not claim those excluded suites ran.',
      knownExclusions: [
        {
          source: 'scripts/local-loop.test.ts',
          suite:
            'macOS sandbox enforces writes, link aliases, descendants, signals and network denial',
          condition: "process.platform !== 'darwin' || process.env.LOCAL_LOOP_SANDBOXED === '1'",
          reason:
            'The unit command runs inside the loop sandbox and cannot nest the sandbox self-test. The coordinator owns its separate startup enforcement checks; this exclusion does not waive an application requirement.',
        },
        {
          source: 'scripts/local-loop.test.ts',
          suite:
            'real isolated checks, artifact production and UAT accept controlled agent handoffs',
          condition: "process.env.LOOP_TEST_RUNTIME !== '1'",
          reason:
            'Opt-in loop integration/hardening exercise; recursively starting the whole loop is not part of ordinary unit checks.',
        },
        {
          source: 'packages/uat/runner.test.mjs',
          suite: 'acceptance command owns repeated runs, failure evidence, and teardown',
          condition: '!process.env.UAT_TEST_ARTIFACTS',
          reason:
            'Opt-in runner hardening against explicitly supplied artifacts. The separate required UAT command runs the current candidate journeys; it does not claim every injected-failure runner regression ran.',
        },
        {
          source: 'packages/core/src/recipes.test.ts',
          suite: 'recipes',
          condition: "process.env.RUN_DB_TESTS !== '1'",
          reason:
            'DB-backed integration suite is opt-in. Schema tests still run; required browser UAT separately exercises the real disposable database.',
        },
        {
          source: 'packages/api/src/app.test.ts',
          suite: 'DB-backed recipe routes',
          condition: "process.env.RUN_DB_TESTS !== '1'",
          reason:
            'DB-backed integration suite is opt-in. In-memory API tests still run; required browser UAT separately exercises the real API/database.',
        },
      ],
      unknownSkips:
        'Unexplained skips or missing evidence for an explicitly required contract check require uncertainty/human input. Known exclusions are not passes, do not excuse other skipped tests, and do not waive requirements that explicitly request those suites.',
    },
  }
}
