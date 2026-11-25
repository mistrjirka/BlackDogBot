#!/usr/bin/env python3
"""Out-of-process BlackDogBot release manager. No third-party package required for deployment."""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import pwd
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

SERVICE_DEFAULT = "blackdogbot.service"
ID_RE = re.compile(r"^[0-9a-f]{40}$")
STARTED = "BlackDogBot daemon is running."
TELEGRAM_READY = ("Telegram bot is now receiving updates.", "Telegram not configured. Bot will not start.")
DAEMON_READY_PROTOCOL = "BLACKDOGBOT_READY daemon ready"
TELEGRAM_READY_PROTOCOL = ("BLACKDOGBOT_READY telegram ready", "BLACKDOGBOT_READY telegram disabled")


def run(argv: list[str], *, cwd: Path | None = None, timeout: int = 180, log: Path | None = None, separate_stderr: bool = False) -> subprocess.CompletedProcess[str]:
    if log:
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as out:
            out.write(f"\n$ {' '.join(argv)}\n")
            out.flush()
            return subprocess.run(argv, cwd=cwd, text=True, stdout=out, stderr=subprocess.STDOUT, timeout=timeout, check=True)
    return subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE if separate_stderr else subprocess.STDOUT, timeout=timeout, check=True)


def write_atomic(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        sync_directory(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


def sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def point_to(path: Path, target: Path) -> None:
    link = path.parent / f".{path.name}-{os.getpid()}.tmp"
    try:
        link.symlink_to(target)
        os.replace(link, path)
        sync_directory(path.parent)
    finally:
        link.unlink(missing_ok=True)


def notify(state: Path, chat: str | None, message: str) -> None:
    """A small independent Telegram notifier; never prints the bot token."""
    if not chat:
        return
    try:
        import yaml
        cfg = yaml.safe_load((Path.home() / ".blackdogbot" / "config.yaml").read_text())
        token = cfg["telegram"]["botToken"]
        if not isinstance(token, str) or not token:
            return
        data = urllib.parse.urlencode({"chat_id": chat, "text": message[:3500]}).encode()
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        request = urllib.request.Request(url, data=data, method="POST")
        with urllib.request.urlopen(request, timeout=9) as response:
            response.read()
    except Exception as exc:
        # Keep a durable retryable record, without printing token/URL or sensitive traceback.
        write_atomic(state / "reports" / "telegram-notify-failed.txt", f"Notification failed: {type(exc).__name__}\n")


def report(state: Path, result: dict[str, object]) -> Path:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = stamp + "-" + str(os.getpid())
    path = state / "reports" / (name + ".json")
    write_atomic(path, json.dumps(result, indent=2, default=str) + "\n")
    write_atomic(state / "reports" / "latest.json", json.dumps(result, indent=2, default=str) + "\n")
    return path


def report_best_effort(state: Path, result: dict[str, object]) -> Path | None:
    """Terminal diagnostics must not prevent or misreport a recovery decision."""
    try:
        return report(state, result)
    except Exception as exc:
        print(f"Guarded deployment reached {result.get('status', 'unknown')}, but the report could not be written ({type(exc).__name__}).",
              file=sys.stderr)
        return None


def source_repository(explicit: Path | None, state: Path) -> Path:
    """Find the user's source checkout without embedding a maintainer's path."""
    def valid(candidate: Path) -> bool:
        try:
            return (candidate / ".git").exists() and json.loads((candidate / "package.json").read_text()).get("name") == "blackdogbot"
        except (OSError, ValueError, AttributeError):
            return False

    if explicit is not None:
        candidate = explicit.expanduser().resolve()
        if not valid(candidate):
            raise RuntimeError(f"Not a BlackDogBot source checkout: {candidate}")
        return candidate
    configured = os.environ.get("BLACKDOGBOT_SOURCE_DIR")
    if configured:
        return source_repository(Path(configured), state)

    candidates = [Path(__file__).resolve().parent.parent]
    cwd = Path.cwd()
    candidates.extend([cwd, *cwd.parents])
    try:
        saved = json.loads((state / "source-repository.json").read_text())["path"]
        if isinstance(saved, str):
            candidates.append(Path(saved).expanduser())
    except (OSError, ValueError, KeyError, TypeError):
        pass
    candidates.append(Path.home() / ".local/share/blackdogbot/source")
    for candidate in candidates:
        if valid(candidate):
            return candidate.resolve()
    raise RuntimeError("Source checkout not found. Supply --repo or BLACKDOGBOT_SOURCE_DIR.")


def revision(repo: Path, ref: str) -> str:
    value = run(["git", "rev-parse", "--verify", ref + "^{commit}"], cwd=repo).stdout.strip()
    if not ID_RE.fullmatch(value):
        raise RuntimeError("Invalid Git commit reference")
    return value


def release_for(state: Path, rev: str) -> Path:
    if not ID_RE.fullmatch(rev):
        raise ValueError("Not a full Git SHA")
    return state / "releases" / rev


def prepare(repo: Path, state: Path, ref: str, chat: str | None) -> Path:
    rev = revision(repo, ref)
    dest = release_for(state, rev)
    log = state / "reports" / f"prepare-{rev[:12]}.log"
    notify(state, chat, f"BlackDogBot: preparing and testing candidate {rev[:12]}. Live service unchanged.")
    if dest.exists():
        if (dest / ".blackdog-release-tested").is_file():
            return dest
        raise RuntimeError(f"Candidate exists but has not passed tests: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "worktree", "add", "--detach", str(dest), rev], cwd=repo, timeout=60, log=log)
    try:
        run(["pnpm", "install", "--frozen-lockfile"], cwd=dest, timeout=600, log=log)
        run(["pnpm", "exec", "tsc", "--noEmit"], cwd=dest, timeout=180, log=log)
        run(["pnpm", "test:fast"], cwd=dest, timeout=600, log=log)
        run(["python3", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py", "-q"],
            cwd=dest, timeout=60, log=log)
        write_atomic(dest / ".blackdog-release-tested", rev + "\n")
        notify(state, chat, f"BlackDogBot candidate {rev[:12]} passed dependency, TypeScript and full fast tests. Activation not yet performed.")
    except Exception as exc:
        report(state, {"status": "prepare_failed", "revision": rev, **error_details(exc),
                       "log": str(log), "candidate": str(dest), "live_unchanged": True})
        notify(state, chat, f"BlackDogBot candidate {rev[:12]} failed preparation ({type(exc).__name__}). Current bot unchanged; diagnostics: {log}")
        raise
    return dest


def service_identity(unit: str) -> tuple[str, int, str]:
    result = run(["systemctl", "--user", "show", unit, "-p", "ActiveState", "-p", "MainPID", "-p", "InvocationID"])
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return values.get("ActiveState", "unknown"), int(values.get("MainPID") or "0"), values.get("InvocationID", "")


def service_state(unit: str) -> tuple[str, int]:
    active, pid, _ = service_identity(unit)
    return active, pid


def health(unit: str, before_pid: int, started_at: float, *, timeout: int = 75) -> bool:
    end = time.monotonic() + timeout
    stable_since: float | None = None
    stable_identity: tuple[int, str] | None = None
    while time.monotonic() < end:
        try:
            active, pid, invocation = service_identity(unit)
            if active != "active" or pid <= 0 or pid == before_pid or not re.fullmatch(r"[0-9a-f]{32}", invocation):
                stable_since = None
                stable_identity = None
                time.sleep(1.5)
                continue
            identity = (pid, invocation)
            if identity != stable_identity:
                stable_since = None
                stable_identity = identity
            # An invocation identifies one service start, including its child
            # processes. Earlier ready logs must not bless a restart loop.
            after = run(["journalctl", "--user", "-u", unit,
                         f"_SYSTEMD_INVOCATION_ID={invocation}", "--since", f"@{int(started_at)}",
                         "--no-pager", "-o", "cat"], timeout=10).stdout
            lines = set(after.splitlines())
            daemon_ready = DAEMON_READY_PROTOCOL in lines or STARTED in after
            telegram_ready = any(marker in lines for marker in TELEGRAM_READY_PROTOCOL) or any(marker in after for marker in TELEGRAM_READY)
            if daemon_ready and telegram_ready:
                if stable_since is None:
                    stable_since = time.monotonic()
                if time.monotonic() - stable_since >= 6:
                    if service_identity(unit) != ("active", pid, invocation):
                        stable_since = None
                        continue
                    return True
            else:
                stable_since = None
        except Exception:
            stable_since = None
            stable_identity = None
        time.sleep(2)
    return False


def save_journal(unit: str, state: Path, prefix: str, since: float) -> Path:
    dest = state / "reports" / (prefix + ".journal.log")
    try:
        text = run(["journalctl", "--user", "-u", unit, "--since", f"@{int(since)}", "--no-pager", "-o", "cat"], timeout=15).stdout
    except Exception:
        text = "Journal unavailable\n"
    write_atomic(dest, text[-50000:])
    return dest


def restart_and_probe(unit: str, old_pid: int, *, timeout: int = 75) -> tuple[bool, float]:
    started = time.time()
    try:
        run(["systemctl", "--user", "restart", unit], timeout=45)
        return health(unit, old_pid, started, timeout=timeout), started
    except Exception:
        return False, started


def update_docker_services(state: Path, chat: str | None) -> dict[str, str]:
    """After app health, independently test and update each enabled Compose service.

    Failed service updates roll back their own image and never invalidate the
    known-good BlackDogBot release. Results are saved in deployment reports.
    """
    compose = Path.home() / ".blackdogbot/docker-compose.yaml"
    updater = Path.home() / ".local/lib/blackdogbot/guarded-container-update.py"
    if not compose.is_file() or not updater.is_file():
        return {"status": "skipped", "reason": "Compose or independent updater not installed"}
    updates: dict[str, str] = {}
    compose_text = compose.read_text()
    for service in ("searxng", "scrapling"):
        if f"  {service}:" not in compose_text:
            updates[service] = "skipped:not_configured"
            continue
        # The updater determines whether the registry digest changed and whether
        # the registry digest changed. Never run docker compose down or prune.
        try:
            arguments = ["python3", str(updater), "--service", service,
                         "--update-latest", "--compose", str(compose)]
            if chat:
                arguments.extend(["--chat-id", chat])
            response = run(arguments, timeout=1100)
            status = response.stdout.strip().splitlines()[-1] if response.stdout.strip() else ""
            updates[service] = status if response.returncode == 0 else "failed"
        except Exception as exc:
            updates[service] = "failed:" + type(exc).__name__
            notify(state, chat, f"{service} container update failed; prior image retained or restored. Inspect container reports.")
    return updates


def default_data_directory() -> Path:
    configured = os.environ.get("BLACKDOGBOT_DATA_DIR")
    if configured is not None:
        if not Path(configured).is_absolute():
            raise RuntimeError("BLACKDOGBOT_DATA_DIR must be an absolute path")
        return Path(configured)
    return Path.home() / ".blackdogbot"


def normalize_data_directory(data_dir: Path) -> Path:
    if not data_dir.is_absolute():
        raise RuntimeError("Data directory must be an absolute path")
    # Match Node path.resolve without following a symlink that the data runner
    # would reject during daemon startup.
    normalized = Path(os.path.abspath(data_dir))
    if normalized.is_symlink():
        raise RuntimeError("Data directory must not be a symlink")
    return normalized


def validate_service_data_directory(unit: str, pid: int, data_dir: Path) -> None:
    """Check the actual service environment without exposing unrelated values."""
    if pid > 0:
        try:
            raw = Path(f"/proc/{pid}/environ").read_bytes()
        except OSError:
            raise RuntimeError("Cannot verify the running service data directory. Retry after checking the service process.") from None
        environment = {}
        for item in raw.split(b"\0"):
            key, separator, value = item.partition(b"=")
            if separator and key in (b"HOME", b"BLACKDOGBOT_DATA_DIR"):
                environment[key.decode()] = os.fsdecode(value)
    else:
        properties = run(["systemctl", "--user", "show", unit, "-p", "Environment",
                          "-p", "EnvironmentFiles", "-p", "UnsetEnvironment"]).stdout
        values = dict(line.split("=", 1) for line in properties.splitlines() if "=" in line)
        if values.get("EnvironmentFiles", "").strip():
            raise RuntimeError("Cannot verify a stopped service with EnvironmentFiles. Verify its data directory while the service is running.")
        manager = run(["systemctl", "--user", "show-environment"]).stdout
        environment = {}
        for line in manager.splitlines():
            entries = shlex.split(line)
            if len(entries) == 1 and "=" in entries[0]:
                key, value = entries[0].split("=", 1)
                environment[key] = value
        for entry in shlex.split(values.get("Environment", "")):
            key, separator, value = entry.partition("=")
            if separator:
                environment[key] = value
        for entry in shlex.split(values.get("UnsetEnvironment", "")):
            key, separator, value = entry.partition("=")
            if not separator or environment.get(key) == value:
                environment.pop(key, None)
    configured = environment.get("BLACKDOGBOT_DATA_DIR")
    if configured is not None:
        if not Path(configured).is_absolute():
            raise RuntimeError("Service BLACKDOGBOT_DATA_DIR is not absolute")
        actual = normalize_data_directory(Path(configured))
    else:
        service_home = environment.get("HOME") or pwd.getpwuid(os.geteuid()).pw_dir
        actual = normalize_data_directory(Path(service_home) / ".blackdogbot")
    if actual != data_dir:
        raise RuntimeError(f"Requested data directory does not match service data directory: {actual}. Use matching --data-dir.")


def stop_and_verify(unit: str) -> None:
    run(["systemctl", "--user", "stop", unit], timeout=45)
    active, pid = service_state(unit)
    if pid != 0 or active not in ("inactive", "failed"):
        raise RuntimeError("Service has not stopped. Runtime data must not be migrated with an active writer.")


def migration_script(release: Path) -> Path:
    return release / "src/migrations/cli.ts"


class MigrationCommandError(RuntimeError):
    """Only a supported CLI's sanitized failure fields may cross this boundary."""
    def __init__(self, reason: str, transaction_id: str | None = None):
        super().__init__(reason)
        self.transaction_id = transaction_id


def migration_failure(output: str | None) -> MigrationCommandError:
    try:
        failure = json.loads(output or "")
    except (ValueError, TypeError):
        failure = None
    if (isinstance(failure, dict) and type(failure.get("protocolVersion")) is int
            and failure["protocolVersion"] == 1 and failure.get("status") == "failed"
            and isinstance(failure.get("error"), str) and failure["error"].strip()):
        reason = failure["error"].replace("\r", " ").replace("\n", " ").strip()[:1000]
        transaction = failure.get("transactionId")
        if not isinstance(transaction, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", transaction):
            transaction = None
        return MigrationCommandError(reason, transaction)
    return MigrationCommandError("Migration command failed without a supported structured error. Keep the service stopped if it was stopped.")


def error_details(error: Exception) -> dict:
    details = {"error": type(error).__name__}
    if isinstance(error, MigrationCommandError):
        details["reason"] = str(error)
        if error.transaction_id is not None:
            details["migration_transaction"] = error.transaction_id
    return details


def migration_command(release: Path, data_dir: Path, action: str, transaction: str | None = None, *,
                      backup_dir: Path | None = None, import_legacy_tasks: bool = False) -> dict:
    argv = [str(release / "node_modules/.bin/tsx"), str(migration_script(release)), action]
    if action != "backup-verify":
        argv.extend(["--data-dir", str(data_dir)])
    if action not in ("plan", "backup-verify"):
        argv.append("--offline")
    if transaction is not None:
        argv.extend(["--transaction", transaction])
    if backup_dir is not None:
        argv.extend(["--backup-dir", str(backup_dir)])
    if import_legacy_tasks:
        if action not in ("plan", "apply"):
            raise ValueError("Legacy import is valid only for plan/apply")
        argv.append("--import-legacy-tasks")
    try:
        response = run(argv, cwd=release, timeout=1800 if action.startswith("backup-") else 600, separate_stderr=True)
    except subprocess.CalledProcessError as exc:
        raise migration_failure(exc.stdout) from None
    except subprocess.TimeoutExpired:
        raise MigrationCommandError("Migration command timed out. Keep the service stopped and inspect the migration journal before recovery.") from None
    try:
        result = json.loads(response.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("Migration command did not return valid JSON") from None
    if not isinstance(result, dict) or type(result.get("protocolVersion")) is not int or result["protocolVersion"] != 1:
        raise RuntimeError("Unsupported migration command protocol")
    if action == "plan":
        if not isinstance(result.get("needsMigration"), bool):
            raise RuntimeError("Migration plan is incomplete")
    elif action == "apply":
        if result.get("status") not in ("applied", "unchanged"):
            raise RuntimeError("Migration command did not complete")
        transaction_id = result.get("transactionId")
        if result["status"] == "applied" and not isinstance(transaction_id, str):
            raise RuntimeError("Migration command omitted its rollback receipt")
        if transaction_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]+", transaction_id):
            raise RuntimeError("Invalid migration transaction receipt")
    elif action == "rollback" and result.get("status") != "rolled_back":
        raise RuntimeError("Migration rollback did not complete")
    elif action in ("backup-create", "backup-verify"):
        expected_status = "created" if action == "backup-create" else "verified"
        if result.get("status") != expected_status or result.get("backupPath") != str(backup_dir):
            raise RuntimeError("Backup command returned an unexpected status or location")
        digest = result.get("manifestSha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise RuntimeError("Backup command omitted a valid manifest hash")
        if any(type(result.get(key)) is not int or result[key] < 0 for key in ("fileCount", "totalBytes")):
            raise RuntimeError("Backup command omitted valid inventory totals")
    return result


def backup_destination(data_dir: Path, rev: str, root: Path | None) -> Path:
    root = root if root is not None else data_dir.parent / (data_dir.name + "-backups")
    if not root.is_absolute():
        raise RuntimeError("Backup root must be an absolute path")
    root = Path(os.path.abspath(root))
    if root == data_dir or root.is_relative_to(data_dir):
        raise RuntimeError("Backup root must be outside the runtime data directory")
    if any(candidate.is_symlink() for candidate in (root, *root.parents)):
        raise RuntimeError("Backup root must not use symlink directories")
    if root.exists() and not root.is_dir():
        raise RuntimeError("Backup root must be a directory")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return root / f"{stamp}-{rev[:12]}-{uuid.uuid4().hex}"


def create_verified_backup(release: Path, data_dir: Path, destination: Path) -> dict:
    created = migration_command(release, data_dir, "backup-create", backup_dir=destination)
    verified = migration_command(release, data_dir, "backup-verify", backup_dir=destination)
    for key in ("backupPath", "manifestSha256", "fileCount", "totalBytes"):
        if created.get(key) != verified.get(key):
            raise MigrationCommandError("Backup verification does not match the created snapshot")
    return verified


def can_start_release(release: Path, data_dir: Path) -> None:
    if migration_script(release).is_file():
        plan = migration_command(release, data_dir, "plan")
        if plan["needsMigration"]:
            raise RuntimeError("Release requires a data migration before startup")
    else:
        marker = data_dir / ".data-schema.json"
        migration_dir = data_dir / ".migrations"
        if migration_dir.is_symlink():
            raise RuntimeError("Migration metadata directory must not be a symlink")
        barriers = [marker, migration_dir / "lock.json", migration_dir / "recovery.json"]
        if any(barrier.exists() or barrier.is_symlink() for barrier in barriers):
            raise RuntimeError("Release cannot verify this data schema. Refusing an unverified downgrade.")
        transactions = data_dir / ".migrations/transactions"
        if transactions.is_symlink():
            raise RuntimeError("Migration journal location is unsafe")
        if transactions.exists():
            for entry in transactions.iterdir():
                if entry.name.startswith(".staging-"):
                    continue
                if entry.is_symlink() or not entry.is_dir():
                    raise RuntimeError("Migration history contains an unknown entry")
                try:
                    journal_path = entry / "journal.json"
                    if journal_path.is_symlink():
                        raise ValueError("symlink")
                    journal = json.loads(journal_path.read_text())
                    if journal.get("formatVersion") != 1 or journal.get("id") != entry.name or journal.get("status") != "rolled_back":
                        raise ValueError("incomplete or unknown transaction")
                except (OSError, ValueError, AttributeError):
                    raise RuntimeError("Migration history must be recovered before starting a legacy release") from None


def activate(state: Path, unit: str, ref: str, chat: str | None, *, timeout: int = 75,
             update_containers: bool = True, data_dir: Path | None = None,
             backup_root: Path | None = None, import_legacy_tasks: bool = False) -> bool:
    data_dir = normalize_data_directory(data_dir or default_data_directory())
    current = state / "current"
    if not current.is_symlink():
        raise RuntimeError("Guarded release launcher is not bootstrapped; refusing unguarded deployment")
    previous = current.resolve(strict=True)
    rev = ref if ID_RE.fullmatch(ref) else revision(previous, ref)
    candidate = release_for(state, rev)
    marker = candidate / ".blackdog-release-tested"
    if not candidate.is_dir() or not marker.is_file() or marker.read_text().strip() != rev:
        raise RuntimeError("Candidate does not have a passing tests marker for this revision")
    if candidate == previous:
        can_start_release(candidate, data_dir)
        active, pid = service_state(unit)
        validate_service_data_directory(unit, pid, data_dir)
        if active != "active" or pid <= 0:
            raise RuntimeError("Selected release is stopped. Recover any pending migration and restart explicitly.")
        return True

    has_migrations = migration_script(candidate).is_file()
    migration_options = {"import_legacy_tasks": True} if import_legacy_tasks else {}
    if has_migrations:
        # Reject unknown data before stopping a healthy service. Apply replans
        # after shutdown because runtime files can change while planning.
        try:
            plan = migration_command(candidate, data_dir, "plan", **migration_options)
        except Exception as exc:
            report(state, {"status": "preflight_failed", "revision": rev, "previous": previous.name,
                           "unit": unit, "data_unchanged": True, "service_unchanged": True, **error_details(exc)})
            raise
    else:
        can_start_release(candidate, data_dir)
        plan = {}
    if type(plan.get("backupProtocolVersion")) is not int or plan["backupProtocolVersion"] != 1:
        raise RuntimeError("Candidate does not support verified persistent-data backups. Prepare a newer release before activation.")
    if plan.get("backupReady") is not True:
        issue = plan.get("backupIssue")
        reason = issue.replace("\r", " ").replace("\n", " ").strip()[:1000] if isinstance(issue, str) else "Backup preflight is not ready. Inspect the migration plan."
        error = MigrationCommandError(reason or "Backup preflight is not ready.")
        report(state, {"status": "preflight_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, "data_unchanged": True, "service_unchanged": True, **error_details(error)})
        raise error
    destination = backup_destination(data_dir, rev, backup_root)
    _, old_pid = service_state(unit)
    validate_service_data_directory(unit, old_pid, data_dir)
    transaction: str | None = None
    backup: dict | None = None
    notify(state, chat, f"BlackDogBot: activating tested release {rev[:12]}. Rollback release {previous.name[:12]} is preserved.")
    try:
        stop_and_verify(unit)
    except Exception as exc:
        report(state, {"status": "stop_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, **error_details(exc), "data_unchanged": True})
        return False
    try:
        backup = create_verified_backup(candidate, data_dir, destination)
        # This receipt is durable before any code or schema change. Every later
        # outcome retains it, including failures and rollback conflicts.
        report(state, {"status": "backup_ready", "revision": rev, "previous": previous.name,
                       "unit": unit, "service_stopped": True, "backup": backup})
    except Exception as exc:
        report(state, {"status": "backup_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, **error_details(exc), "service_stopped": True,
                       "data_unchanged": True, "backup_path": str(destination), "backup_verified": False})
        notify(state, chat, "BlackDogBot backup failed. The service remains stopped, the previous release is selected, and no migration was applied.")
        return False

    # If this manager is interrupted during migration, a subsequent boot must
    # use the candidate's pending-transaction startup checks.
    point_to(current, candidate)
    try:
        receipt = migration_command(candidate, data_dir, "apply", **migration_options)
        transaction = receipt.get("transactionId")
    except Exception as exc:
        report(state, {"status": "migration_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, **error_details(exc), "service_stopped": True,
                       "data_dir": str(data_dir), "backup": backup, "manual_recovery_required": True,
                       "recovery_action": "Run candidate migration CLI recover while the service is stopped."})
        notify(state, chat, "BlackDogBot data migration failed. The service remains stopped. Inspect the migration journal and recover before restarting.")
        return False

    ok, started = restart_and_probe(unit, old_pid, timeout=timeout)
    if ok:
        container_results = update_docker_services(state, chat) if update_containers else {"status": "skipped_by_request"}
        path = report_best_effort(state, {"status": "healthy", "revision": rev, "previous": previous.name,
                              "unit": unit, "activated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                              "migration_transaction": transaction, "backup": backup, "container_updates": container_results})
        report_note = f"Report: {path}" if path is not None else "Deployment report could not be written."
        notify(state, chat, f"BlackDogBot: release {rev[:12]} healthy. Container updates: {container_results}. {report_note}")
        return True

    journal: Path | None = None
    diagnostics: dict[str, str] = {}
    candidate_stopped = False
    recovery_phase = "stop_candidate" if has_migrations else "check_previous_schema"
    try:
        if has_migrations:
            stop_and_verify(unit)
            candidate_stopped = True
        # Stop the failed process before collecting logs. Disk or permission
        # failures in diagnostics must never prevent the restore decision.
        try:
            journal = save_journal(unit, state, f"failed-{rev[:12]}", started)
        except Exception as exc:
            diagnostics["journal_save_error"] = type(exc).__name__
        if has_migrations:
            recovery_phase = "restore_data"
            if transaction is not None:
                migration_command(candidate, data_dir, "rollback", transaction)
        recovery_phase = "check_previous_schema"
        can_start_release(previous, data_dir)
    except Exception as exc:
        path = report_best_effort(state, {"status": "data_recovery_failed", "failed_revision": rev,
                              "previous_revision": previous.name, "unit": unit,
                              "journal": str(journal) if journal is not None else None,
                              "migration_transaction": transaction, **error_details(exc), **diagnostics,
                              "manual_recovery_required": True, "candidate": str(candidate),
                              "service_stopped": candidate_stopped, "recovery_phase": recovery_phase, "backup": backup})
        report_note = f"Inspect {path}." if path is not None else "Report unavailable. Inspect the service and migration journal."
        notify(state, chat, f"BlackDogBot: candidate health failed and data could not be safely restored. Prior code was not started. {report_note}")
        return False

    point_to(current, previous)
    _, failed_pid = service_state(unit)
    restored, _ = restart_and_probe(unit, failed_pid, timeout=timeout)
    outcome = {
        "status": "rolled_back" if restored else "rollback_failed",
        "failed_revision": rev, "restored_revision": previous.name, "unit": unit,
        "journal": str(journal) if journal is not None else None,
        "candidate": str(candidate), "previous_available": previous.is_dir(),
        "migration_transaction": transaction, "backup": backup, **diagnostics,
    }
    path = report_best_effort(state, outcome)
    report_note = f"Logs and report saved at {path}." if path is not None else "Deployment report could not be written."
    notify(state, chat, f"BlackDogBot: candidate {rev[:12]} FAILED health check. " +
           (f"Rolled back to {previous.name[:12]}." if restored else "Rollback ALSO FAILED; manual recovery needed!") +
           f" {report_note} Failed candidate retained.")
    return False


def bootstrap(state: Path, unit: str, rev: str, chat: str | None, *, data_dir: Path | None = None) -> bool:
    """One-time migration. Restores original unit override on startup failure."""
    release = release_for(state, rev)
    data_dir = normalize_data_directory(data_dir or default_data_directory())
    if not (release / ".blackdog-release-tested").exists():
        raise RuntimeError("Bootstrap requires a fully tested baseline release")
    can_start_release(release, data_dir)
    if (state / "current").exists() or (state / "current").is_symlink():
        raise RuntimeError("Already bootstrapped; refusing to overwrite current release")
    wrapper = Path.home() / ".local" / "lib" / "blackdogbot" / "launch-stable.sh"
    dropin = Path.home() / ".config" / "systemd" / "user" / f"{unit}.d" / "40-guarded-release.conf"
    if dropin.exists():
        raise RuntimeError("Existing guarded launcher override found; refusing overwrite")
    script = "#!/bin/sh\nset -eu\nexec " + shutil.which("bash") + ' "' + str(state / "current" / "scripts" / "launch.sh") + '"\n'
    _, old_pid = service_state(unit)
    validate_service_data_directory(unit, old_pid, data_dir)
    write_atomic(wrapper, script, 0o700)
    os.chmod(wrapper, 0o700)
    point_to(state / "current", release)
    dropin_text = "[Service]\nExecStart=\nExecStart=" + str(wrapper) + "\nWorkingDirectory=" + str(state / "current") + "\n"
    write_atomic(dropin, dropin_text, 0o600)
    notify(state, chat, f"BlackDogBot: migrating existing service to guarded, tested release {rev[:12]}. Original unit remains available.")
    try:
        run(["systemctl", "--user", "daemon-reload"], timeout=15)
        ok, started = restart_and_probe(unit, old_pid)
        if ok:
            report(state, {"status": "bootstrap_healthy", "revision": rev, "unit": unit})
            notify(state, chat, f"BlackDogBot: guarded launcher installed and healthy at {rev[:12]}.")
            return True
        save_journal(unit, state, f"bootstrap-failed-{rev[:12]}", started)
    except Exception:
        pass
    dropin.unlink(missing_ok=True)
    (state / "current").unlink(missing_ok=True)
    run(["systemctl", "--user", "daemon-reload"], timeout=15)
    try:
        run(["systemctl", "--user", "restart", unit], timeout=45)
    except Exception:
        pass
    report(state, {"status": "bootstrap_reverted", "revision": rev, "unit": unit})
    notify(state, chat, "BlackDogBot: guarded launcher migration failed. Original service configuration restored; inspect deployment logs.")
    return False


def main() -> int:
    # Support npm-installed pnpm in the user directory without requiring root.
    os.environ["PATH"] = str(Path.home() / ".local/bin") + os.pathsep + os.environ.get("PATH", "")
    parser = argparse.ArgumentParser(description="BlackDogBot: out-of-process tested release preparation and rollback")
    parser.add_argument("action", choices=["prepare", "bootstrap", "activate"])
    parser.add_argument("--repo", type=Path, help="Source checkout (or BLACKDOGBOT_SOURCE_DIR)")
    parser.add_argument("--state", type=Path, default=Path.home() / ".blackdogbot" / "deploy")
    parser.add_argument("--data-dir", type=Path, default=default_data_directory(), help="Runtime data root for migration checks (must match service)")
    parser.add_argument("--backup-root", type=Path, help="Snapshot parent directory outside runtime data (default: data-root sibling)")
    parser.add_argument("--import-legacy-tasks", action="store_true", help="Explicitly import supported legacy task directories during activation")
    parser.add_argument("--revision", required=True, help="Commit revision for preparation/activation")
    parser.add_argument("--unit", default=SERVICE_DEFAULT)
    parser.add_argument("--chat-id", help="Authorized Telegram chat to receive status notifications")
    parser.add_argument("--timeout", type=int, default=75)
    parser.add_argument("--skip-container-updates", action="store_true", help="Deploy app only")
    args = parser.parse_args()
    if (args.import_legacy_tasks or args.backup_root is not None) and args.action != "activate":
        parser.error("--import-legacy-tasks and --backup-root are valid only for activate")
    if not re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", args.unit):
        parser.error("Invalid systemd unit")
    state = args.state.expanduser().resolve()
    if args.chat_id is None:
        try:
            known = json.loads((Path.home() / ".blackdogbot" / "known-telegram-chats.json").read_text())
            if isinstance(known, list) and len(known) == 1 and str(known[0]).lstrip("-").isdigit():
                args.chat_id = str(known[0])
        except (OSError, ValueError, TypeError):
            pass
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    (state / "reports").mkdir(mode=0o700, exist_ok=True)
    with (state / "deploy.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "prepare":
            repo = source_repository(args.repo, state)
            path = prepare(repo, state, args.revision, args.chat_id)
            write_atomic(state / "source-repository.json", json.dumps({"path": str(repo)}) + "\n")
            print(f"Prepared and tested: {path}")
            return 0
        if args.action == "bootstrap":
            rev = revision(source_repository(args.repo, state), args.revision)
            return 0 if bootstrap(state, args.unit, rev, args.chat_id, data_dir=args.data_dir.expanduser()) else 1
        return 0 if activate(state, args.unit, args.revision, args.chat_id, timeout=args.timeout,
                             update_containers=not args.skip_container_updates, data_dir=args.data_dir.expanduser(),
                             backup_root=args.backup_root.expanduser() if args.backup_root is not None else None,
                             import_legacy_tasks=args.import_legacy_tasks) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Do not print config files or token-containing request URLs.
        print(f"Guarded release failed: {type(error).__name__}: {str(error)[:240]}", file=sys.stderr)
        sys.exit(2)
