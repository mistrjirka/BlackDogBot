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
        try:
            write_atomic(state / "reports" / "telegram-notify-failed.txt", f"Notification failed: {type(exc).__name__}\n")
        except Exception:
            pass  # Diagnostics must not change a deployment or recovery result.


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
        runtime = runtime_process_pid(pid)
        try:
            raw = Path(f"/proc/{runtime}/environ").read_bytes()
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
                      backup_dir: Path | None = None, import_legacy_tasks: bool = False,
                      runtime_cwd: Path | None = None, source: Path | None = None) -> dict:
    argv = [str(release / "node_modules/.bin/tsx"), str(migration_script(release)), action]
    if action != "backup-verify":
        argv.extend(["--data-dir", str(data_dir)])
    if action not in ("plan", "paths-plan", "backup-verify"):
        argv.append("--offline")
    if transaction is not None:
        argv.extend(["--transaction", transaction])
    if backup_dir is not None:
        argv.extend(["--backup-dir", str(backup_dir)])
    if runtime_cwd is not None or source is not None:
        if action not in ("plan", "paths-plan", "paths-apply"):
            raise ValueError("Database source discovery is valid only for plan/paths-plan/paths-apply")
        if runtime_cwd is not None:
            argv.extend(["--runtime-cwd", str(runtime_cwd)])
        if source is not None:
            argv.extend(["--source", str(source)])
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
    if action.startswith("paths-") and (type(result.get("pathMigrationProtocolVersion")) is not int
                                       or result["pathMigrationProtocolVersion"] != 1):
        raise RuntimeError("Unsupported database-path migration protocol")
    if action in ("plan", "paths-plan"):
        if not isinstance(result.get("needsMigration"), bool):
            raise RuntimeError("Migration plan is incomplete")
    elif action in ("apply", "paths-apply"):
        if result.get("status") not in ("applied", "unchanged"):
            raise RuntimeError("Migration command did not complete")
        transaction_id = result.get("transactionId")
        if result["status"] == "applied" and not isinstance(transaction_id, str):
            raise RuntimeError("Migration command omitted its rollback receipt")
        if transaction_id is not None and not re.fullmatch(r"[A-Za-z0-9_-]+", transaction_id):
            raise RuntimeError("Invalid migration transaction receipt")
    elif action in ("rollback", "paths-rollback") and result.get("status") != "rolled_back":
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



def private_json(path: Path) -> dict | None:
    """Read bounded, user-owned metadata without following links."""
    import stat
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise RuntimeError("Activation metadata must not use symlink paths")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536 or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError("Activation metadata must be a private regular file owned by this user")
        try:
            value = json.load(stream)
        except (ValueError, UnicodeError):
            raise RuntimeError("Activation metadata is invalid. Keep the service stopped and recover the upgrade.") from None
    if not isinstance(value, dict):
        raise RuntimeError("Activation metadata must be an object")
    return value


def activation_file(data_dir: Path) -> Path:
    return data_dir / "deploy/activation.json"


def activation_context_file(data_dir: Path, nonce: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", nonce):
        raise RuntimeError("Invalid activation nonce")
    return data_dir / "deploy/activations" / nonce / "context.json"


def read_activation(data_dir: Path) -> dict | None:
    value = private_json(activation_file(data_dir))
    if value is None:
        return None
    if (type(value.get("protocolVersion")) is not int or value["protocolVersion"] != 1
            or value.get("status") not in ("pending", "committed")
            or not isinstance(value.get("nonce"), str) or not re.fullmatch(r"[0-9a-f]{32}", value["nonce"])
            or not isinstance(value.get("revision"), str) or not ID_RE.fullmatch(value["revision"])
            or not isinstance(value.get("candidatePath"), str) or not Path(value["candidatePath"]).is_absolute()
            or str(Path(os.path.abspath(value["candidatePath"]))) != value["candidatePath"]
            or value.get("dataDir") != str(data_dir) or not isinstance(value.get("createdAt"), str)):
        raise RuntimeError("Activation approval is incomplete or incompatible")
    try:
        dt.datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00"))
    except ValueError:
        raise RuntimeError("Activation approval has an invalid date") from None
    if value["status"] == "committed" and (
            type(value.get("runtimePid")) is not int or value["runtimePid"] <= 0
            or not isinstance(value.get("invocationId"), str)
            or not re.fullmatch(r"[0-9a-f]{32}", value["invocationId"])):
        raise RuntimeError("Committed activation omitted its runtime identity")
    return value


def begin_activation(data_dir: Path, candidate: Path, context: dict) -> dict:
    previous = read_activation(data_dir)
    if previous is not None and previous["status"] == "pending":
        raise RuntimeError("Another activation is pending. Resume that revision before selecting new code.")
    nonce = uuid.uuid4().hex
    approval = {"protocolVersion": 1, "status": "pending", "nonce": nonce,
                "revision": candidate.name, "candidatePath": str(candidate.resolve()),
                "dataDir": str(data_dir), "createdAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    previous_release = private_json(data_dir / "deploy/activation-release.json")
    context = {**context, "protocolVersion": 1, "nonce": nonce, "previousApproval": previous,
               "previousRelease": previous_release}
    location = activation_context_file(data_dir, nonce)
    if any(part.is_symlink() for part in (location, *location.parents)):
        raise RuntimeError("Activation recovery location must not use symlinks")
    write_atomic(location, json.dumps(context, indent=2) + "\n")
    # A crash before this write cannot open a candidate's prepared-release gate.
    write_atomic(activation_file(data_dir), json.dumps(approval, indent=2) + "\n")
    return approval


def activation_context(data_dir: Path, approval: dict, state: Path, unit: str) -> dict:
    context = private_json(activation_context_file(data_dir, approval["nonce"]))
    if (not context or context.get("protocolVersion") != 1 or context.get("nonce") != approval["nonce"]
            or context.get("statePath") != str(state.resolve()) or context.get("unit") != unit):
        raise RuntimeError("Pending activation has no matching recovery receipt. Keep the service stopped.")
    previous = context.get("previousPath")
    if context.get("origin") == "activate" and (not isinstance(previous, str) or not Path(previous).is_absolute()
                                               or not Path(previous).is_dir()):
        raise RuntimeError("Pending activation previous release is unavailable")
    return context


def restore_activation(data_dir: Path, approval: dict, context: dict) -> None:
    current = read_activation(data_dir)
    if not current or current["nonce"] != approval["nonce"] or current["status"] != "pending":
        raise RuntimeError("Activation was accepted or changed. Automatic rollback is no longer safe.")
    previous = context.get("previousApproval")
    if previous is None:
        activation_file(data_dir).unlink()
        sync_directory(activation_file(data_dir).parent)
    else:
        write_atomic(activation_file(data_dir), json.dumps(previous, indent=2) + "\n")
    release_file = data_dir / "deploy/activation-release.json"
    if context.get("previousRelease") is None:
        release_file.unlink(missing_ok=True)
        sync_directory(release_file.parent)
    else:
        write_atomic(release_file, json.dumps(context["previousRelease"]) + "\n")
    # Archive the outcome as well as the original receipt; retain both for recovery.
    write_atomic(activation_context_file(data_dir, approval["nonce"]).parent / "outcome.json",
                 json.dumps({"status": "rolled_back", "completedAt": dt.datetime.now(dt.timezone.utc).isoformat()}) + "\n")


def runtime_belongs_to_service(runtime_pid: int, main_pid: int, invocation: str) -> bool:
    """tsx uses a child Node process, so MainPID alone is not a runtime identity."""
    try:
        environ = Path(f"/proc/{runtime_pid}/environ").read_bytes().split(b"\0")
        if f"INVOCATION_ID={invocation}".encode() not in environ:
            return False
        cursor = runtime_pid
        visited = set()
        while cursor > 1 and cursor not in visited:
            if cursor == main_pid:
                return True
            visited.add(cursor)
            status = Path(f"/proc/{cursor}/status").read_text()
            cursor = int(next(line.split(":", 1)[1].strip() for line in status.splitlines() if line.startswith("PPid:")))
    except (OSError, ValueError, StopIteration):
        return False
    return False


def activation_ready(data_dir: Path, approval: dict, unit: str, expected_status: str) -> dict | None:
    ready = private_json(data_dir / "deploy/activation-ready.json")
    if not ready:
        return None
    active, main_pid, invocation = service_identity(unit)
    if (active != "active" or main_pid <= 0 or not re.fullmatch(r"[0-9a-f]{32}", invocation)
            or ready.get("protocolVersion") != 1 or ready.get("status") != expected_status
            or any(ready.get(key) != approval.get(key) for key in ("nonce", "revision", "candidatePath"))
            or ready.get("invocationId") != invocation or type(ready.get("pid")) is not int or ready["pid"] <= 0
            or not runtime_belongs_to_service(ready["pid"], main_pid, invocation)):
        return None
    return ready


def wait_for_staged_readiness(unit: str, data_dir: Path, approval: dict, *, timeout: int) -> dict | None:
    deadline = time.monotonic() + timeout
    stable = None
    stable_since = None
    while time.monotonic() < deadline:
        try:
            ready = activation_ready(data_dir, approval, unit, "pending")
        except Exception:
            ready = None
        identity = (ready["pid"], ready["invocationId"]) if ready else None
        if identity is not None and identity == stable:
            if time.monotonic() - stable_since >= 6:
                return ready
        else:
            stable, stable_since = identity, time.monotonic() if identity is not None else None
        time.sleep(1)
    return None


def activation_released(data_dir: Path, approval: dict) -> bool:
    release = private_json(data_dir / "deploy/activation-release.json")
    return bool(release and approval["status"] == "committed" and release.get("protocolVersion") == 1
                and all(release.get(key) == approval.get(key) for key in
                        ("nonce", "revision", "candidatePath", "runtimePid", "invocationId")))


def commit_activation(data_dir: Path, approval: dict, ready: dict, unit: str) -> None:
    current = read_activation(data_dir)
    if current != approval or activation_released(data_dir, current):
        raise RuntimeError("Activation approval changed before acceptance")
    confirmed = activation_ready(data_dir, approval, unit, "pending")
    if confirmed != ready:
        raise RuntimeError("Candidate invocation changed before acceptance")
    committed = {**approval, "status": "committed", "runtimePid": ready["pid"],
                 "invocationId": ready["invocationId"], "acceptedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    # Do not release external work until both the approval and its directory are synced.
    write_atomic(activation_file(data_dir), json.dumps(committed, indent=2) + "\n")
    # This second file is the runtime release signal. The approval is already
    # durable before this signal can become visible, including across crashes.
    write_atomic(data_dir / "deploy/activation-release.json", json.dumps({
        key: committed[key] for key in ("protocolVersion", "nonce", "revision", "candidatePath", "runtimePid", "invocationId")
    }) + "\n")


def guarded_start_and_probe(unit: str, old_pid: int, data_dir: Path, approval: dict, *,
                            timeout: int = 75, restart: bool = True) -> tuple[bool, float]:
    started = time.time()
    try:
        if restart:
            run(["systemctl", "--user", "restart", unit], timeout=45)
        if not activation_released(data_dir, approval):
            ready = wait_for_staged_readiness(unit, data_dir, approval, timeout=timeout)
            if ready is None:
                return False, started
            commit_activation(data_dir, approval, ready, unit)
        # An accepted restart may have a new PID. Its receipt must still prove
        # this approval, and health must use the actual current invocation.
        healthy = health(unit, old_pid if restart else 0, started if restart else 0, timeout=timeout)
        return healthy and activation_ready(data_dir, approval, unit, "active") is not None, started
    except Exception:
        return False, started



def runtime_process_pid(main_pid: int, proc_root: Path = Path("/proc")) -> int:
    """Find the actual Node child, not pnpm/tsx/shell's service parent."""
    if main_pid <= 0:
        raise RuntimeError("Cannot discover a runtime from a stopped service")
    parents = {}
    try:
        for entry in proc_root.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                status = (entry / "status").read_text()
                parents[int(entry.name)] = int(next(line.split(":", 1)[1].strip() for line in status.splitlines() if line.startswith("PPid:")))
            except (OSError, ValueError, StopIteration):
                continue
        main_group = (proc_root / str(main_pid) / "cgroup").read_bytes()
        owner = (proc_root / str(main_pid)).stat().st_uid
    except OSError:
        raise RuntimeError("Cannot inspect the service runtime process") from None
    descendants = {}
    for pid in parents:
        cursor, depth, seen = pid, 0, set()
        while cursor > 1 and cursor not in seen:
            if cursor == main_pid:
                descendants[pid] = depth
                break
            seen.add(cursor)
            cursor = parents.get(cursor, 0)
            depth += 1
    matches = []
    for pid, depth in descendants.items():
        entry = proc_root / str(pid)
        try:
            if entry.stat().st_uid != owner or (entry / "cgroup").read_bytes() != main_group:
                continue
            executable = (entry / "exe").resolve(strict=True).name
            if executable not in ("node", "nodejs"):
                continue
            argv = [os.fsdecode(part) for part in (entry / "cmdline").read_bytes().split(b"\0") if part]
            if any(arg == "src/index.ts" or arg.endswith("/src/index.ts")
                   or arg == "dist/index.js" or arg.endswith("/dist/index.js")
                   or arg == "dist/src/index.js" or arg.endswith("/dist/src/index.js") for arg in argv[1:]):
                matches.append((pid, depth))
        except OSError:
            continue
    # Exclude an enclosing tsx process when its actual runtime child also matches.
    leaves = []
    for pid, depth in matches:
        is_parent = False
        for other, _ in matches:
            cursor, seen = other, set()
            while cursor > 1 and cursor not in seen and cursor != pid:
                seen.add(cursor)
                cursor = parents.get(cursor, 0)
            if other != pid and cursor == pid:
                is_parent = True
                break
        if not is_parent:
            leaves.append(pid)
    if len(leaves) != 1:
        raise RuntimeError("Cannot identify one actual bot runtime. Check service children before selecting a legacy database source.")
    return leaves[0]


def service_runtime_cwd(unit: str, pid: int, explicit: Path | None) -> Path | None:
    if explicit is not None and (not explicit.is_absolute() or not explicit.is_dir()):
        raise RuntimeError("--runtime-cwd must name an existing absolute directory")
    if pid > 0:
        runtime = runtime_process_pid(pid)
        try:
            actual = Path(f"/proc/{runtime}/cwd").resolve(strict=True)
        except OSError:
            raise RuntimeError("Cannot discover the old runtime working directory. Check the service process.") from None
        if explicit is not None and explicit.resolve() != actual:
            raise RuntimeError("--runtime-cwd does not match the actual running bot process")
        return actual
    if explicit is not None:
        return explicit.resolve()
    result = run(["systemctl", "--user", "show", unit, "-p", "WorkingDirectory", "--value"]).stdout.strip()
    return Path(result).resolve() if result and Path(result).is_absolute() else None


def require_candidate_protocol(plan: dict) -> None:
    if type(plan.get("backupProtocolVersion")) is not int or plan["backupProtocolVersion"] != 1:
        raise RuntimeError("Candidate does not support verified persistent-data backups. Prepare a newer release before activation.")
    if type(plan.get("activationProtocolVersion")) is not int or plan["activationProtocolVersion"] != 1:
        raise RuntimeError("Candidate does not support guarded external-work activation. Prepare a newer release before activation.")
    paths = plan.get("databasePathMigration")
    if paths is not None and (not isinstance(paths, dict) or plan.get("pathMigrationProtocolVersion") != 1):
        raise RuntimeError("Candidate has an unsupported database-path migration protocol")


def require_backup_ready(plan: dict, *, allow_path_migration: bool = False) -> None:
    if plan.get("backupReady") is True:
        return
    paths = plan.get("databasePathMigration")
    if (allow_path_migration and isinstance(paths, dict) and paths.get("needsMigration") is True
            and plan.get("preBackupMigrationReady") is True):
        return
    issue = plan.get("backupIssue")
    reason = issue.replace("\r", " ").replace("\n", " ").strip()[:1000] if isinstance(issue, str) else "Backup preflight is not ready. Inspect the migration plan."
    raise MigrationCommandError(reason or "Backup preflight is not ready.")



@contextlib.contextmanager
def activation_lock(data_dir: Path):
    location = data_dir / "deploy/activation.lock"
    if any(part.is_symlink() for part in (location, *location.parents)):
        raise RuntimeError("Activation lock path must not use symlinks")
    location.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(location, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def finish_activation(state: Path, unit: str, data_dir: Path, candidate: Path, approval: dict,
                      context: dict, chat: str | None, *, old_pid: int, timeout: int,
                      update_containers: bool, restart: bool = True) -> bool:
    previous = Path(context["previousPath"])
    rev = candidate.name
    transaction = context.get("migrationTransaction")
    path_transaction = context.get("pathMigrationTransaction")
    backup = context.get("backup")
    ok, started = guarded_start_and_probe(unit, old_pid, data_dir, approval, timeout=timeout, restart=restart)
    current_approval = None
    approval_error = None
    try:
        current_approval = read_activation(data_dir)
        if not current_approval or current_approval["nonce"] != approval["nonce"]:
            raise RuntimeError("Activation approval changed during startup")
        if ok and current_approval["status"] == "committed" and activation_released(data_dir, current_approval):
            try:
                containers = update_docker_services(state, chat) if update_containers else {"status": "skipped_by_request"}
            except Exception as exc:
                containers = {"status": "failed", "error": type(exc).__name__}
            receipt = {"status": "healthy", "revision": rev, "previous": previous.name, "unit": unit,
                       "activated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                       "migration_transaction": transaction, "path_migration_transaction": path_transaction,
                       "activation_nonce": approval["nonce"], "backup": backup, "container_updates": containers}
            report_best_effort(state, receipt)
            notify(state, chat, f"BlackDogBot: release {rev[:12]} accepted and healthy.")
            return True
    except Exception as exc:
        approval_error = exc

    journal = None
    diagnostics = {}
    stopped = False
    phase = "stop_candidate"
    try:
        stop_and_verify(unit)
        stopped = True
        try:
            journal = save_journal(unit, state, f"failed-{rev[:12]}", started)
        except Exception as exc:
            diagnostics["journal_save_error"] = type(exc).__name__
        # Once durable acceptance exists, any external effect may have happened.
        # Keep the selected code/data and receipts. Never overwrite new work.
        if approval_error is not None or current_approval is None or current_approval["status"] == "committed":
            report_best_effort(state, {"status": "activation_committed_unhealthy" if approval_error is None else "activation_state_unknown",
                "revision": rev, "previous": previous.name, "unit": unit, "service_stopped": True,
                "manual_recovery_required": True, "migration_transaction": transaction,
                "path_migration_transaction": path_transaction, "activation_nonce": approval["nonce"],
                "journal": str(journal) if journal else None, "backup": backup, **diagnostics,
                "recovery_action": "Inspect the accepted candidate and restart it explicitly. Do not restore older data over possible new work."})
            return False
        phase = "restore_data"
        if transaction is not None:
            migration_command(candidate, data_dir, "rollback", transaction)
        phase = "restore_database_path"
        if path_transaction is not None:
            migration_command(candidate, data_dir, "paths-rollback", path_transaction)
        phase = "check_previous_schema"
        can_start_release(previous, data_dir)
        phase = "restore_activation"
        restore_activation(data_dir, approval, context)
    except Exception as exc:
        report_best_effort(state, {"status": "data_recovery_failed", "failed_revision": rev,
            "previous_revision": previous.name, "unit": unit, "journal": str(journal) if journal else None,
            "migration_transaction": transaction, "path_migration_transaction": path_transaction,
            "activation_nonce": approval["nonce"], "backup": backup, **error_details(exc), **diagnostics,
            "manual_recovery_required": True, "candidate": str(candidate), "service_stopped": stopped,
            "recovery_phase": phase})
        return False
    point_to(state / "current", previous)
    _, failed_pid = service_state(unit)
    restored, _ = restart_and_probe(unit, failed_pid, timeout=timeout)
    report_best_effort(state, {"status": "rolled_back" if restored else "rollback_failed",
        "failed_revision": rev, "restored_revision": previous.name, "unit": unit,
        "journal": str(journal) if journal else None, "candidate": str(candidate),
        "previous_available": previous.is_dir(), "migration_transaction": transaction,
        "path_migration_transaction": path_transaction, "activation_nonce": approval["nonce"],
        "backup": backup, **diagnostics})
    notify(state, chat, f"BlackDogBot: candidate {rev[:12]} failed validation. " +
           ("Previous release restored." if restored else "Previous release needs manual recovery."))
    return False


def activate(state: Path, unit: str, ref: str, chat: str | None, *, timeout: int = 75,
             update_containers: bool = True, data_dir: Path | None = None,
             backup_root: Path | None = None, import_legacy_tasks: bool = False,
             runtime_cwd: Path | None = None, database_source: Path | None = None) -> bool:
    data_dir = normalize_data_directory(data_dir or default_data_directory())
    with activation_lock(data_dir):
        return _activate_locked(state, unit, ref, chat, timeout=timeout, update_containers=update_containers,
                                data_dir=data_dir, backup_root=backup_root, import_legacy_tasks=import_legacy_tasks,
                                runtime_cwd=runtime_cwd, database_source=database_source)


def _activate_locked(state: Path, unit: str, ref: str, chat: str | None, *, timeout: int,
                     update_containers: bool, data_dir: Path, backup_root: Path | None,
                     import_legacy_tasks: bool, runtime_cwd: Path | None, database_source: Path | None) -> bool:
    current = state / "current"
    if not current.is_symlink():
        raise RuntimeError("Guarded release launcher is not bootstrapped; refusing unguarded deployment")
    previous = current.resolve(strict=True)
    rev = ref if ID_RE.fullmatch(ref) else revision(previous, ref)
    candidate = release_for(state, rev).resolve()
    marker = candidate / ".blackdog-release-tested"
    if not candidate.is_dir() or not marker.is_file() or marker.read_text().strip() != rev:
        raise RuntimeError("Candidate does not have a passing tests marker for this revision")
    active, old_pid = service_state(unit)
    validate_service_data_directory(unit, old_pid, data_dir)
    existing = read_activation(data_dir)
    if existing and existing["status"] == "pending":
        if existing["candidatePath"] != str(candidate) or previous != candidate:
            raise RuntimeError("Another activation is pending. Resume its candidate before selecting a different release.")
        context = activation_context(data_dir, existing, state, unit)
        if context.get("origin") != "activate":
            raise RuntimeError("Pending bootstrap must be resumed with bootstrap")
        can_start_release(candidate, data_dir)
        return finish_activation(state, unit, data_dir, candidate, existing, context, chat,
                                 old_pid=old_pid, timeout=timeout, update_containers=update_containers,
                                 restart=active != "active" or old_pid <= 0)
    if candidate == previous:
        can_start_release(candidate, data_dir)
        if (active != "active" or old_pid <= 0) and (not existing or activation_released(data_dir, existing)):
            raise RuntimeError("Selected release is stopped. Inspect the activation report and restart explicitly before retrying.")
        if not existing or existing["candidatePath"] != str(candidate):
            raise RuntimeError("Selected prepared release has no activation receipt. Recover the interrupted upgrade before restarting.")
        context = activation_context(data_dir, existing, state, unit)
        return finish_activation(state, unit, data_dir, candidate, existing, context, chat,
                                 old_pid=old_pid, timeout=timeout, update_containers=update_containers,
                                 restart=active != "active" or old_pid <= 0)

    migration_options = {"import_legacy_tasks": True} if import_legacy_tasks else {}
    plan_options = dict(migration_options)
    runtime_cwd = service_runtime_cwd(unit, old_pid, runtime_cwd)
    if runtime_cwd is not None:
        plan_options["runtime_cwd"] = runtime_cwd
    if database_source is not None:
        if not database_source.is_absolute():
            raise RuntimeError("--database-source must be an absolute path")
        plan_options["source"] = database_source
    try:
        if migration_script(candidate).is_file():
            plan = migration_command(candidate, data_dir, "plan", **plan_options)
        else:
            can_start_release(candidate, data_dir)
            plan = {}
        require_candidate_protocol(plan)
        require_backup_ready(plan, allow_path_migration=True)
    except Exception as exc:
        report(state, {"status": "preflight_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, "data_unchanged": True, "service_unchanged": True, **error_details(exc)})
        raise
    destination = backup_destination(data_dir, rev, backup_root)
    transaction = None
    path_transaction = None
    backup = None
    needs_paths = (plan.get("databasePathMigration") or {}).get("needsMigration") is True
    notify(state, chat, f"BlackDogBot: validating tested release {rev[:12]}. Previous release {previous.name[:12]} is preserved.")
    try:
        stop_and_verify(unit)
    except Exception as exc:
        report(state, {"status": "stop_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, **error_details(exc), "data_unchanged": True})
        return False
    if needs_paths:
        # A reboot during path migration must enter candidate startup barriers,
        # never old code that cannot recognize this new path journal.
        point_to(current, candidate)
        try:
            path_options = {key: value for key, value in plan_options.items() if key != "import_legacy_tasks"}
            path_receipt = migration_command(candidate, data_dir, "paths-apply", **path_options)
            path_transaction = path_receipt.get("transactionId")
            report(state, {"status": "database_path_ready", "revision": rev, "previous": previous.name,
                           "unit": unit, "service_stopped": True, "path_migration_transaction": path_transaction})
            post_paths = migration_command(candidate, data_dir, "plan", **plan_options)
            require_candidate_protocol(post_paths)
            require_backup_ready(post_paths)
        except Exception as exc:
            if isinstance(exc, MigrationCommandError) and exc.transaction_id is not None:
                path_transaction = exc.transaction_id
            report_best_effort(state, {"status": "database_path_failed", "revision": rev, "previous": previous.name,
                "unit": unit, "service_stopped": True, "path_migration_transaction": path_transaction,
                **error_details(exc), "manual_recovery_required": True,
                "recovery_action": "Run candidate paths-recover while stopped, then inspect its receipt before restoring previous code."})
            return False
    try:
        backup = create_verified_backup(candidate, data_dir, destination)
        report(state, {"status": "backup_ready", "revision": rev, "previous": previous.name,
                       "unit": unit, "service_stopped": True, "backup": backup,
                       "path_migration_transaction": path_transaction})
    except Exception as exc:
        restored_paths = path_transaction is None
        path_error = None
        if path_transaction is not None:
            try:
                migration_command(candidate, data_dir, "paths-rollback", path_transaction)
                restored_paths = True
            except Exception as recovery_error:
                path_error = error_details(recovery_error)
        if needs_paths and restored_paths:
            point_to(current, previous)
        report_best_effort(state, {"status": "backup_failed", "revision": rev, "previous": previous.name,
            "unit": unit, **error_details(exc), "service_stopped": True,
            "data_unchanged": restored_paths, "backup_path": str(destination), "backup_verified": False,
            "path_migration_transaction": path_transaction, "path_recovery_error": path_error,
            "manual_recovery_required": not restored_paths})
        return False

    point_to(current, candidate)
    try:
        receipt = migration_command(candidate, data_dir, "apply", **migration_options)
        transaction = receipt.get("transactionId")
    except Exception as exc:
        report(state, {"status": "migration_failed", "revision": rev, "previous": previous.name,
                       "unit": unit, **error_details(exc), "service_stopped": True,
                       "data_dir": str(data_dir), "backup": backup, "path_migration_transaction": path_transaction,
                       "manual_recovery_required": True,
                       "recovery_action": "Run candidate migration recover while stopped. Restore task changes before paths-rollback."})
        return False
    context = {"origin": "activate", "statePath": str(state.resolve()), "unit": unit,
               "previousPath": str(previous), "migrationTransaction": transaction,
               "pathMigrationTransaction": path_transaction, "backup": backup}
    try:
        approval = begin_activation(data_dir, candidate, context)
        context = activation_context(data_dir, approval, state, unit)
        report(state, {"status": "activation_pending", "revision": rev, "previous": previous.name, "unit": unit,
                       "activation_nonce": approval["nonce"], "migration_transaction": transaction,
                       "path_migration_transaction": path_transaction, "backup": backup})
    except Exception as exc:
        report_best_effort(state, {"status": "activation_prepare_failed", "revision": rev, "unit": unit,
            "service_stopped": True, "manual_recovery_required": True, "backup": backup,
            "migration_transaction": transaction, "path_migration_transaction": path_transaction, **error_details(exc)})
        return False
    return finish_activation(state, unit, data_dir, candidate, approval, context, chat,
                             old_pid=old_pid, timeout=timeout, update_containers=update_containers)



def install_bootstrap_launcher(state: Path, release: Path, wrapper: Path, dropin: Path, *, resume: bool) -> None:
    bash = shutil.which("bash")
    if not bash:
        raise RuntimeError("bash is required for the stable launcher")
    script = "#!/bin/sh\nset -eu\nexec " + shlex.quote(bash) + " " + shlex.quote(str(state / "current/scripts/launch.sh")) + "\n"
    def unit_quote(value: Path) -> str:
        return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'
    dropin_text = "[Service]\nExecStart=\nExecStart=" + unit_quote(wrapper) + "\nWorkingDirectory=" + unit_quote(state / "current") + "\n"
    for file, expected in ((wrapper, script), (dropin, dropin_text)):
        if any(part.is_symlink() for part in (file, *file.parents)):
            raise RuntimeError("Bootstrap launcher paths must not use symlinks")
        if resume and file.exists() and file.read_text() != expected:
            raise RuntimeError("Bootstrap launcher changed after interruption. Preserve it and recover explicitly.")
    write_atomic(wrapper, script, 0o700)
    os.chmod(wrapper, 0o700)
    point_to(state / "current", release)
    write_atomic(dropin, dropin_text, 0o600)


def bootstrap(state: Path, unit: str, rev: str, chat: str | None, *, data_dir: Path | None = None,
              timeout: int = 75) -> bool:
    """Install a guarded launcher after validation; retain accepted failures."""
    data_dir = normalize_data_directory(data_dir or default_data_directory())
    with activation_lock(data_dir):
        return _bootstrap_locked(state, unit, rev, chat, data_dir=data_dir, timeout=timeout)


def _bootstrap_locked(state: Path, unit: str, rev: str, chat: str | None, *, data_dir: Path, timeout: int) -> bool:
    release = release_for(state, rev).resolve()
    marker = release / ".blackdog-release-tested"
    if not marker.is_file() or marker.read_text().strip() != rev:
        raise RuntimeError("Bootstrap requires a fully tested baseline release")
    wrapper = Path.home() / ".local/lib/blackdogbot/launch-stable.sh"
    dropin = Path.home() / ".config/systemd/user" / f"{unit}.d/40-guarded-release.conf"
    current = state / "current"
    active, old_pid = service_state(unit)
    validate_service_data_directory(unit, old_pid, data_dir)
    existing = read_activation(data_dir)
    resume = existing is not None and existing["candidatePath"] == str(release) and (
        (current.is_symlink() and current.resolve() == release) or not (current.exists() or current.is_symlink()))
    reinstall = False
    if resume:
        context = activation_context(data_dir, existing, state, unit)
        if context.get("origin") != "bootstrap" or context.get("dropinPath") != str(dropin):
            raise RuntimeError("Existing activation is not this bootstrap. Resume it with activate.")
        can_start_release(release, data_dir)
        approval = existing
        if not activation_released(data_dir, approval):
            stop_and_verify(unit)
            reinstall = True
    else:
        if current.exists() or current.is_symlink():
            raise RuntimeError("Already bootstrapped; refusing to overwrite current release")
        if dropin.exists() or dropin.is_symlink():
            raise RuntimeError("Existing guarded launcher override found; refusing overwrite")
        if existing and existing["status"] == "pending":
            raise RuntimeError("Another activation is pending")
        runtime_cwd = service_runtime_cwd(unit, old_pid, None)
        options = {"runtime_cwd": runtime_cwd} if runtime_cwd is not None else {}
        plan = migration_command(release, data_dir, "plan", **options)
        require_candidate_protocol(plan)
        require_backup_ready(plan)
        if plan["needsMigration"] or (plan.get("databasePathMigration") or {}).get("needsMigration"):
            raise RuntimeError("Bootstrap cannot migrate runtime data. Use the upgrade entry point.")
        stop_and_verify(unit)
        backup = create_verified_backup(release, data_dir, backup_destination(data_dir, rev, None))
        report(state, {"status": "bootstrap_backup_ready", "revision": rev, "unit": unit, "backup": backup})
        context = {"origin": "bootstrap", "statePath": str(state.resolve()), "unit": unit,
                   "dropinPath": str(dropin), "wrapperPath": str(wrapper), "backup": backup}
        approval = begin_activation(data_dir, release, context)
        context = activation_context(data_dir, approval, state, unit)
        reinstall = True
    if reinstall:
        install_bootstrap_launcher(state, release, wrapper, dropin, resume=resume)
        run(["systemctl", "--user", "daemon-reload"], timeout=15)
    ok, started = guarded_start_and_probe(unit, old_pid, data_dir, approval, timeout=timeout,
                                         restart=reinstall or not resume or active != "active" or old_pid <= 0)
    try:
        latest = read_activation(data_dir)
    except Exception:
        latest = None
    if ok and latest and latest["nonce"] == approval["nonce"] and activation_released(data_dir, latest):
        report_best_effort(state, {"status": "bootstrap_healthy", "revision": rev, "unit": unit,
                                  "activation_nonce": approval["nonce"], "backup": context.get("backup")})
        notify(state, chat, f"BlackDogBot: guarded launcher installed and healthy at {rev[:12]}.")
        return True
    stop_and_verify(unit)
    try:
        save_journal(unit, state, f"bootstrap-failed-{rev[:12]}", started)
    except Exception:
        pass
    if not latest or latest["nonce"] != approval["nonce"] or latest["status"] == "committed":
        report_best_effort(state, {"status": "bootstrap_committed_unhealthy", "revision": rev, "unit": unit,
            "service_stopped": True, "manual_recovery_required": True, "backup": context.get("backup"),
            "activation_nonce": approval["nonce"]})
        return False
    restore_activation(data_dir, approval, context)
    dropin.unlink(missing_ok=True)
    sync_directory(dropin.parent)
    current.unlink(missing_ok=True)
    sync_directory(current.parent)
    run(["systemctl", "--user", "daemon-reload"], timeout=15)
    restored, _ = restart_and_probe(unit, 0, timeout=timeout)
    report_best_effort(state, {"status": "bootstrap_reverted" if restored else "bootstrap_recovery_failed",
                              "revision": rev, "unit": unit, "backup": context.get("backup"),
                              "activation_nonce": approval["nonce"]})
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
    parser.add_argument("--runtime-cwd", type=Path, help="Old service working directory for legacy database source discovery")
    parser.add_argument("--database-source", type=Path, help="Explicit absolute legacy knowledge database source")
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
            return 0 if bootstrap(state, args.unit, rev, args.chat_id, data_dir=args.data_dir.expanduser(), timeout=args.timeout) else 1
        return 0 if activate(state, args.unit, args.revision, args.chat_id, timeout=args.timeout,
                             update_containers=not args.skip_container_updates, data_dir=args.data_dir.expanduser(),
                             backup_root=args.backup_root.expanduser() if args.backup_root is not None else None,
                             import_legacy_tasks=args.import_legacy_tasks, runtime_cwd=args.runtime_cwd,
                             database_source=args.database_source) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Do not print config files or token-containing request URLs.
        print(f"Guarded release failed: {type(error).__name__}: {str(error)[:240]}", file=sys.stderr)
        sys.exit(2)
