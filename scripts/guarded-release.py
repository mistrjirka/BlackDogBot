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
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

SERVICE_DEFAULT = "blackdogbot.service"
ID_RE = re.compile(r"^[0-9a-f]{40}$")
STARTED = ("BlackDogBot daemon is running.", "Telegram bot is now receiving updates.")


def run(argv: list[str], *, cwd: Path | None = None, timeout: int = 180, log: Path | None = None) -> subprocess.CompletedProcess[str]:
    if log:
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as out:
            out.write(f"\n$ {' '.join(argv)}\n")
            out.flush()
            return subprocess.run(argv, cwd=cwd, text=True, stdout=out, stderr=subprocess.STDOUT, timeout=timeout, check=True)
    return subprocess.run(argv, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, check=True)


def write_atomic(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def point_to(path: Path, target: Path) -> None:
    link = path.parent / f".{path.name}-{os.getpid()}.tmp"
    try:
        link.symlink_to(target)
        os.replace(link, path)
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
        run(["python3", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_guarded_*.py", "-q"],
            cwd=dest, timeout=60, log=log)
        write_atomic(dest / ".blackdog-release-tested", rev + "\n")
        notify(state, chat, f"BlackDogBot candidate {rev[:12]} passed dependency, TypeScript and full fast tests. Activation not yet performed.")
    except Exception as exc:
        report(state, {"status": "prepare_failed", "revision": rev, "error": type(exc).__name__,
                       "log": str(log), "candidate": str(dest), "live_unchanged": True})
        notify(state, chat, f"BlackDogBot candidate {rev[:12]} failed preparation ({type(exc).__name__}). Current bot unchanged; diagnostics: {log}")
        raise
    return dest


def service_state(unit: str) -> tuple[str, int]:
    result = run(["systemctl", "--user", "show", unit, "-p", "ActiveState", "-p", "MainPID"])
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    return values.get("ActiveState", "unknown"), int(values.get("MainPID") or "0")


def health(unit: str, before_pid: int, started_at: float, *, timeout: int = 75) -> bool:
    end = time.monotonic() + timeout
    stable_since: float | None = None
    while time.monotonic() < end:
        try:
            active, pid = service_state(unit)
            if active != "active" or pid <= 0 or pid == before_pid:
                stable_since = None
                time.sleep(1.5)
                continue
            after = run(["journalctl", "--user", "-u", unit, "--since", f"@{int(started_at)}", "--no-pager", "-o", "cat"], timeout=10).stdout
            if all(marker in after for marker in STARTED):
                if stable_since is None:
                    stable_since = time.monotonic()
                if time.monotonic() - stable_since >= 6:
                    return True
            else:
                stable_since = None
        except Exception:
            stable_since = None
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


def activate(state: Path, unit: str, ref: str, chat: str | None, *, timeout: int = 75) -> bool:
    current = state / "current"
    if not current.is_symlink():
        raise RuntimeError("Guarded release launcher is not bootstrapped; refusing unguarded deployment")
    previous = current.resolve(strict=True)
    rev = ref if ID_RE.fullmatch(ref) else revision(previous, ref)
    candidate = release_for(state, rev)
    if not candidate.is_dir() or not (candidate / ".blackdog-release-tested").is_file():
        raise RuntimeError("Candidate does not have a passing tests marker")
    if candidate == previous:
        return True
    _, old_pid = service_state(unit)
    notify(state, chat, f"BlackDogBot: activating tested release {rev[:12]}. Rollback release {previous.name[:12]} is preserved.")
    point_to(current, candidate)
    ok, started = restart_and_probe(unit, old_pid, timeout=timeout)
    if ok:
        path = report(state, {"status": "healthy", "revision": rev, "previous": previous.name,
                              "unit": unit, "activated_at": dt.datetime.now(dt.timezone.utc).isoformat()})
        notify(state, chat, f"BlackDogBot: release {rev[:12]} is healthy. Verified startup and Telegram polling. Report: {path}")
        return True

    journal = save_journal(unit, state, f"failed-{rev[:12]}", started)
    point_to(current, previous)
    _, failed_pid = service_state(unit)
    restored, _ = restart_and_probe(unit, failed_pid, timeout=timeout)
    outcome = {
        "status": "rolled_back" if restored else "rollback_failed",
        "failed_revision": rev, "restored_revision": previous.name, "unit": unit,
        "journal": str(journal), "candidate": str(candidate), "previous_available": previous.is_dir(),
    }
    path = report(state, outcome)
    notify(state, chat, f"BlackDogBot: candidate {rev[:12]} FAILED health check. " +
           (f"Rolled back to {previous.name[:12]}." if restored else "Rollback ALSO FAILED; manual recovery needed!") +
           f" Logs and report saved at {path}. Failed candidate retained.")
    return False


def bootstrap(state: Path, unit: str, rev: str, chat: str | None) -> bool:
    """One-time migration. Restores original unit override on startup failure."""
    release = release_for(state, rev)
    if not (release / ".blackdog-release-tested").exists():
        raise RuntimeError("Bootstrap requires a fully tested baseline release")
    if (state / "current").exists() or (state / "current").is_symlink():
        raise RuntimeError("Already bootstrapped; refusing to overwrite current release")
    wrapper = Path.home() / ".local" / "lib" / "blackdogbot" / "launch-stable.sh"
    dropin = Path.home() / ".config" / "systemd" / "user" / f"{unit}.d" / "40-guarded-release.conf"
    if dropin.exists():
        raise RuntimeError("Existing guarded launcher override found; refusing overwrite")
    script = "#!/bin/sh\nset -eu\nexec " + shutil.which("bash") + ' "' + str(state / "current" / "scripts" / "launch.sh") + '"\n'
    write_atomic(wrapper, script, 0o700)
    os.chmod(wrapper, 0o700)
    _, old_pid = service_state(unit)
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
    parser = argparse.ArgumentParser(description="BlackDogBot: out-of-process tested release preparation and rollback")
    parser.add_argument("action", choices=["prepare", "bootstrap", "activate"])
    parser.add_argument("--repo", type=Path, default=Path.home() / "programy/better-claw")
    parser.add_argument("--state", type=Path, default=Path.home() / ".blackdogbot" / "deploy")
    parser.add_argument("--revision", required=True, help="Commit revision for preparation/activation")
    parser.add_argument("--unit", default=SERVICE_DEFAULT)
    parser.add_argument("--chat-id", help="Authorized Telegram chat to receive status notifications")
    parser.add_argument("--timeout", type=int, default=75)
    args = parser.parse_args()
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
            path = prepare(args.repo.resolve(), state, args.revision, args.chat_id)
            print(f"Prepared and tested: {path}")
            return 0
        if args.action == "bootstrap":
            rev = revision(args.repo.resolve(), args.revision)
            return 0 if bootstrap(state, args.unit, rev, args.chat_id) else 1
        return 0 if activate(state, args.unit, args.revision, args.chat_id, timeout=args.timeout) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Do not print config files or token-containing request URLs.
        print(f"Guarded release failed: {type(error).__name__}: {str(error)[:240]}", file=sys.stderr)
        sys.exit(2)
