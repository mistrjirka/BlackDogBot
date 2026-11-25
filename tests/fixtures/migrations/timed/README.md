# Timed-task migration fixtures

These synthetic fixtures follow the persisted schemas in repository history. They contain no user data.

| Fixture | Schema evidence | Behavior checked |
| --- | --- | --- |
| `legacy-once.json` | `25c43a1`, `src/shared/schemas/cron.schemas.ts` (8 April 2026) | Preserve the exact stored `runAt`. Add the day-start metadata without inventing a new date. |
| `legacy-interval.json` | `6c80f350ce17a7dbc204668c59d02c1aed303d32`, `src/shared/schemas/cron.schemas.ts` (8 April 2026) | Convert whole-minute `intervalMs` and in-day `offsetMinutes` to hour/minute parts. |
| `modern-before-dedup.json` | `49ac57244ae904fdc990f9c8cec101298251ed62`, `src/shared/schemas/cron.schemas.ts` (10 April 2026) | Preserve the modern schedule. Add `messageDedupEnabled: true`, introduced by `91158f0b303e93abd8c621924ced7c81921890f5` (12 April 2026). |

Extra properties deliberately test that migration and later scheduler writes do not discard user extensions. They are not evidence that the old application generated those properties.

## Supported conversion boundary

The interval scheduler changed from a delay after startup to a local day-start grid in `49ac572`. This migration keeps that established conversion, and reports it in its change list. The old startup phase is not stored in the task, so it cannot be recovered.

Intervals below one minute, fractional minutes, intervals longer than one day, offsets outside a day, and conflicting old/new values stop the migration for review. Previous code silently rounded or wrapped these values.

The transient `schedule.type: "scheduled"` shape in `eea9720c574d0791d791969ee901394343bb60c7` (7 April 2026) is not converted. Neither are cron-expression documents from the older `cron/` directory. These need a separate, explicitly tested migration.

The legacy once executor in `6c80f35` used `runAt` directly, even when an `offsetMinutes` field was present. The conversion preserves that behavior. A missing or invalid `runAt` is an error.
