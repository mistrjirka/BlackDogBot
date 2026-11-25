# Retained completed cron record

`completed-once.json` is synthetic. It follows the pre-rename one-time task schema in `25c43a1` and `cb7e956^` (`src/shared/schemas/cron.schemas.ts`).

Commit `cb7e95667bcd63e7490c4be1d2c16db4810029e1` on 8 April 2026 changed the scheduler path from `cron/` to `timed/`. It did not move existing files. Both scheduler versions skipped one-time tasks whose `runAt` was in the past. Successful execution wrote `lastRunStatus: "success"`, `lastRunError: null`, and `lastRunAt`.

The fixture tests recognition of an already completed record using those persisted fields. Recognition preserves the file. It does not copy the task into `timed/`, change `enabled`, or register work with the scheduler. No live task content is included.

Recurring tasks, incomplete tasks, failed tasks, ambiguous schemas, invalid timestamps, and filename mismatches still require an explicit migration.
