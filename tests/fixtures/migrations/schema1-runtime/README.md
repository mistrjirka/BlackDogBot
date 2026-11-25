# Actual schema 1 migration runtime

The nine TypeScript files under `src/` are an immutable dependency slice copied byte-for-byte from commit `d00c480b5e9b0381b430e8f6a3c89ec269238f6a`. They contain the previous migration CLI, engine, lock, task converters, configuration/task schemas, constants, and path helpers.

`source.json` records the source commit and SHA-256 of every copied file. The regression verifies these hashes before preparing a temporary runtime. It uses the test installation's existing `tsx`, YAML, and Zod packages. It does not need Git history, the network, an installed bot, or provider credentials.

The tests launch this actual historical CLI and its `prepareRuntimeDataAsync` gate against a schema 2 -> schema 1 rollback. They prove that old code can read the restored state after future-schema receipts have been preserved under `.migrations/retired-transactions/`.

The slice is intentionally frozen. Changes to current migration code must not silently update this fixture or its hashes. A future compatibility baseline should use a separately identified source snapshot.
