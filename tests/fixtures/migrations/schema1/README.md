# Schema 1 compatibility fixture

These files are synthetic and reproduce the schema marker and migration journal format implemented in `d00c480` (`src/migrations/data-migrations.ts`).

- `marker.json` and `0000.after` contain the exact schema 1 marker bytes used by that release.
- `journal.json` describes a completed baseline transaction from unversioned data to schema 1. Its timestamp and transaction identifier are synthetic. Its recorded checksum matches `0000.after`.
- Schema 1 did not create a legacy import ledger.

The tests install this fixture into a temporary data directory. They verify schema 1 -> schema 2 -> schema 1 restoration, reuse of the original journal after rollback, and recovery of an interrupted schema 1 transaction. No installed bot data is included.
