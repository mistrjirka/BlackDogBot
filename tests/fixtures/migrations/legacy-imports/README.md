# Explicit legacy directory import fixtures

These synthetic tasks use the persisted one-time and interval schemas from `25c43a1` and `6c80f350ce17a7dbc204668c59d02c1aed303d32`. Commit `cb7e95667bcd63e7490c4be1d2c16db4810029e1` renamed the scheduler directory from `cron/` to `timed/` without moving old files.

- `pending-once.json` is an enabled one-time task with no recorded execution. Its exact `runAt` must survive import.
- `interval.json` is a disabled interval task. Its interval and offset follow the known day-start conversion introduced in `49ac57244ae904fdc990f9c8cec101298251ed62`. Import must keep it disabled.
- Both fixtures include synthetic history and extension fields to detect accidental data removal.

Import is explicit. Tests preserve each original `cron/` file, create its new `timed/` task, and record source hashes in the private import ledger. A later deletion of the task must not trigger another import.

These fixtures do not establish support for cron expressions, the transient `scheduled` schema, or arbitrary old tool-name changes. Task instructions and tool selections are preserved rather than translated.
