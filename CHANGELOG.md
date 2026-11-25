# Changelog

## v0.2.0

### Upgrades and data preservation

- Add one standalone upgrade command for guarded installations and supported older user services. It resolves an exact Git revision, prepares and tests the candidate, refreshes the independent supervisor, and records recovery state.
- Add an explicit administrator handoff for supported system services that run as a non-root user. The old system service must be stopped and masked before the user service can start. Custom privileged service layouts require review.
- Convert supported legacy scheduled-task formats through journaled migrations. Preserve original sources, record imports, and prevent deleted tasks from being imported again.
- Create and verify a complete persistent-data snapshot before application activation. Restore snapshots only into a new directory. Automatic failure recovery changes only unchanged migration-owned files.
- Move legacy knowledge databases into the selected data root through a separate recoverable transaction. Detect populated conflicting stores, verify copied bytes, retain the original source, and preserve the original configuration for rollback.
- Default new knowledge databases to an absolute path under the selected data root.
- Hold message polling, task execution, outbox delivery, MCP startup, and Brain commands until the supervisor accepts the candidate. Validate Telegram credentials without consuming queued updates.
- Stop for explicit recovery after a failure following acceptance. Do not automatically roll back data after the new bot may have produced external effects.
- Add optional backup cleanup. Keep three verified snapshots by default, every snapshot newer than 14 days, and recovery backups for current or unresolved deployments. Cleanup is explicit and cannot run during a guarded deployment.

### Installation and releases

- Publish stable version tags only after Linux CI passes on Node 22, 24, and 26.
- Attach a commit-pinned fresh installer, a standalone upgrade script, a release manifest, and SHA-256 checksums.
- Support full commit IDs as well as tags and branches in the bootstrapper. Fresh installations select the latest published stable version by default.
- Refuse to overwrite existing installations. Use the upgrade command for existing data.
- Keep credentials out of test fixtures and test model caches. Validate historical migrations, interrupted upgrades, service conversion, snapshot retention, and release retries.

### Telegram

- Send table-bearing responses through Telegram rich messages with native Markdown tables.
- Fall back to readable per-row HTML only when Telegram explicitly rejects rich messages. Preserve network and rate-limit errors for normal outbox retries.

### Requirements and limits

Linux, Python 3.9+, Node.js 22.13.0+, the declared pnpm version, and a working user systemd manager are required for the managed installation. Container updates are optional and the upgrade entry point skips them by default.

Supported historical data formats are migrated automatically. Unknown formats, conflicting populated stores, modified recovery files, and unsupported privileged service layouts stop with a recovery plan. Originals and snapshots remain available.
