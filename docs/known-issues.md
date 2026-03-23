# Known Issues

This file tracks currently known failing integration tests so we can fix them in a dedicated pass.

## Latest failing integration tests

Source run summaries: mixed integration runs captured in tool outputs from 2026-03-22 and 2026-03-23.

1. `tests/integration/jobs/ai-job-creation-e2e.test.ts`
   - `should create a job when asked by the user`
     - Failure type: timeout
     - Detail: timed out in `600000ms`
     - Observed behavior: model looped for many steps without creating the expected job.

2. `tests/integration/jobs/ai-job-pipeline-e2e.test.ts`
   - `should create, test, finish, and run an RSS + agent job end-to-end`
     - Failure type: assertion
     - Detail: `expected undefined to be defined`
     - Observed behavior: `digestJob` was not created; the model drifted into unrelated `run_cmd` exploration.

3. `tests/integration/jobs/job-execution-e2e.test.ts`
   - `should execute unseen mode: first fetch returns items, second fetch returns empty`
     - Failure type: runtime error
     - Detail: `Cannot find module '../../src/utils/paths.js'`
   - `should unseen mode: maxItems caps returned items even when more are unseen`
     - Failure type: runtime error
     - Detail: `Cannot find module '../../src/utils/paths.js'`
   - `should execute an output_to_ai node that transforms data via LLM`
     - Failure type: assertion
     - Detail: operation aborted during LLM call; `result.success` was `false`.
