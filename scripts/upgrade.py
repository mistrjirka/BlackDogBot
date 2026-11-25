#!/usr/bin/env python3
"""Prepare and apply a reviewed BlackDogBot upgrade without replacing user configuration.

This file uses only the Python standard library so older installations can run a
downloaded, version-pinned copy. Service operations are kept behind explicit CLI
actions. Normal upgrades never invoke sudo or execute as root.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import sys
import urllib.request
import uuid

PROJECT = "mistrjirka/BlackDogBot"
SHA = re.compile(r"^[0-9a-f]{40}$")
TAG = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
UNIT = re.compile(r"^[A-Za-z0-9_.@-]+\.service$")
SYSTEM_DIR = Path("/etc/systemd/system")
ADMIN_DIR = Path("/var/lib/blackdogbot-upgrade")
ROOT_UID = 0
PROPERTIES = (
    "LoadState", "ActiveState", "SubState", "MainPID", "UnitFileState",
    "FragmentPath", "DropInPaths", "User", "Group", "SupplementaryGroups",
    "WorkingDirectory", "ExecStart", "ExecStartPre", "ExecStartPost", "ExecStop",
    "ExecStopPost", "Environment", "EnvironmentFiles", "UnsetEnvironment",
    "DynamicUser", "RootDirectory", "RootImage", "Type", "KillMode", "ControlGroup",
    "Restart", "RestartUSec", "KillSignal", "TimeoutStopUSec",
)
RUNTIME_PROPERTIES = {"ActiveState", "SubState", "MainPID", "UnitFileState", "ControlGroup"}
TERMINAL = {"healthy", "restored"}


class UpgradeError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise UpgradeError(message)


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def absolute(value: str | Path, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        fail(label + " must be an absolute path.")
    return Path(os.path.abspath(path))


def safe_path(path: Path, *, absent: bool = False) -> Path:
    path = absolute(path, "Path")
    for item in [*reversed(path.parents), path]:
        try:
            mode = item.lstat().st_mode
        except FileNotFoundError:
            if absent:
                continue
            raise
        if stat.S_ISLNK(mode):
            fail("A managed path uses a symlink: " + str(item))
    return path


def private_directory(path: Path) -> None:
    safe_path(path, absent=True)
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.stat().st_uid != os.geteuid() or path.stat().st_mode & 0o077:
        fail("Upgrade state must be a private directory owned by this account: " + str(path))


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path: Path, content: bytes, mode: int = 0o600) -> None:
    safe_path(path, absent=True)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary = path.parent / ("." + path.name + "." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path: Path, value: dict) -> None:
    atomic_write(path, (json.dumps(value, indent=2) + "\n").encode())


def read_json(path: Path) -> dict:
    safe_path(path)
    if not path.is_file():
        fail("Expected a regular JSON file: " + str(path))
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        fail("Unsupported upgrade metadata.")
    return value


def run(argv: list[str], *, cwd: Path | None = None, timeout: int = 60,
        log: Path | None = None, check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    environment = os.environ.copy()
    environment["GIT_TERMINAL_PROMPT"] = "0"
    if env:
        environment.update(env)
    if log:
        fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a") as output:
            output.write("\n$ " + shlex.join(argv) + "\n")
            output.flush()
            result = subprocess.run(argv, cwd=cwd, env=environment, text=True,
                                    stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    else:
        result = subprocess.run(argv, cwd=cwd, env=environment, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        fail("Command failed: " + Path(argv[0]).name + (". Inspect " + str(log) if log else "."))
    return result


def systemctl(scope: str, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    executable = root_command("systemctl") if os.geteuid() == 0 else "systemctl"
    return run([executable, *(["--user"] if scope == "user" else []), *args], check=check)


def unit_properties(scope: str, unit: str) -> dict[str, str]:
    if not UNIT.fullmatch(unit):
        fail("Invalid service unit name.")
    result = systemctl(scope, "show", unit, *sum((["-p", key] for key in PROPERTIES), []), check=False)
    if result.returncode:
        return {"LoadState": "not-found"}
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def unit_exists(properties: dict) -> bool:
    return properties.get("LoadState") not in (None, "", "not-found")


def file_snapshot(path: Path) -> dict:
    safe_path(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        fail("A service configuration file is not regular.")
    content = path.read_bytes()
    return {"path": str(path), "sha256": digest(content), "mode": stat.S_IMODE(info.st_mode)}


def unit_files(properties: dict) -> list[dict]:
    names = [properties.get("FragmentPath", ""), *shlex.split(properties.get("DropInPaths", ""))]
    return [file_snapshot(absolute(name, "Unit file")) for name in names if name]


def fingerprint(properties: dict, files: list[dict]) -> str:
    relevant = {key: value for key, value in properties.items() if key not in RUNTIME_PROPERTIES}
    return digest(json.dumps({"properties": relevant, "files": files}, sort_keys=True).encode())


def declared_environment(properties: dict) -> dict[str, str]:
    result = {}
    for item in shlex.split(properties.get("Environment", "")):
        key, separator, value = item.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            fail("Unsupported service environment syntax.")
        if any(ord(character) < 32 for character in value):
            fail("Multiline service environment values require manual migration.")
        result[key] = value
    for item in shlex.split(properties.get("UnsetEnvironment", "")):
        key, separator, value = item.partition("=")
        if not separator or result.get(key) == value:
            result.pop(key, None)
    return result


def process_environment(pid: int) -> dict[str, str]:
    if pid <= 0:
        return {}
    try:
        raw = Path("/proc") / str(pid) / "environ"
        pairs = [item.partition(b"=") for item in raw.read_bytes().split(b"\0")]
        return {os.fsdecode(key): os.fsdecode(value) for key, separator, value in pairs if separator}
    except OSError:
        fail("Cannot inspect the running service environment. Retry after checking its process.")


def runtime_process_pid(main_pid: int, owner: int) -> int:
    """Select the sole bot leaf below systemd MainPID in the same cgroup."""
    proc = Path("/proc")
    try:
        main_group = (proc / str(main_pid) / "cgroup").read_bytes()
        parents = {}
        for item in proc.iterdir():
            if not item.name.isdigit():
                continue
            try:
                fields = (item / "stat").read_text().rsplit(") ", 1)[1].split()
                parents[int(item.name)] = int(fields[1])
            except (OSError, ValueError, IndexError):
                continue
        def below(pid: int, ancestor: int) -> bool:
            visited = set()
            while pid and pid not in visited:
                if pid == ancestor:
                    return True
                visited.add(pid)
                pid = parents.get(pid, 0)
            return False
        matches = []
        for pid in parents:
            if not below(pid, main_pid):
                continue
            item = proc / str(pid)
            try:
                if item.stat().st_uid != owner or (item / "cgroup").read_bytes() != main_group:
                    continue
                executable = (item / "exe").resolve(strict=True).name
                argv = [os.fsdecode(value) for value in (item / "cmdline").read_bytes().split(b"\0") if value]
                if executable in ("node", "nodejs") and any(value.endswith(("src/index.ts", "dist/index.js", "dist/src/index.js")) for value in argv):
                    matches.append(pid)
            except OSError:
                continue
        leaves = [pid for pid in matches if not any(other != pid and below(other, pid) for other in matches)]
        if len(leaves) != 1:
            fail("Cannot identify one running bot Node process. Inspect the service process tree before selecting its runtime directory.")
        return leaves[0]
    except OSError:
        fail("Cannot inspect the service process tree and ownership.")


def runtime_source_entry(pid: int, cwd: Path) -> Path:
    argv = [os.fsdecode(value) for value in (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0") if value]
    entries = [value for value in argv if value.endswith(("src/index.ts", "dist/index.js", "dist/src/index.js"))]
    if len(entries) != 1:
        fail("The bot process has an ambiguous source entry point.")
    entry = Path(entries[0])
    return (entry if entry.is_absolute() else cwd / entry).resolve()


def stopped_source_entry(properties: dict) -> Path:
    working = Path(properties["WorkingDirectory"]).resolve()
    match = re.search(r"argv\[\]=(.*?)\s*;", properties.get("ExecStart", ""))
    for argument in shlex.split(match.group(1)) if match else []:
        path = Path(argument)
        path = path if path.is_absolute() else working / path
        if argument.endswith(("src/index.ts", "dist/index.js", "dist/src/index.js")):
            return path.resolve()
        if argument.endswith("/scripts/launch.sh"):
            return path.resolve().parent.parent / "src/index.ts"
    return working / "src/index.ts"


def runtime_repository(service: dict) -> Path:
    entry = Path(service["runtimeSourceEntry"])
    root = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=entry.parent).stdout.strip()).resolve()
    try:
        valid = json.loads((root / "package.json").read_text()).get("name") == "blackdogbot"
    except (OSError, ValueError):
        valid = False
    if not valid or root not in entry.parents:
        fail("The running source entry point does not identify a BlackDogBot Git checkout.")
    return root


def stopped_runtime_cwd(properties: dict) -> str:
    working = properties.get("WorkingDirectory", "")
    if not working or not Path(working).is_absolute():
        fail("The stopped service needs an absolute verified WorkingDirectory.")
    selected = Path(working).resolve()
    baseline = selected / ".blackdog-legacy-baseline.json"
    if baseline.is_file():
        return str(absolute(read_json(baseline)["runtimeCwd"], "Preserved runtime cwd"))
    match = re.search(r"argv\[\]=(.*?)\s*;", properties.get("ExecStart", ""))
    for argument in shlex.split(match.group(1)) if match else []:
        if argument.endswith("/scripts/launch.sh"):
            script = Path(argument)
            selected = (script if script.is_absolute() else selected / script).resolve().parent.parent
    return str(selected)


def validate_simple_unit(properties: dict, scope: str, account) -> None:
    owner = properties.get("User", "")
    if scope == "system" and owner not in (account.pw_name, str(account.pw_uid)):
        fail("The system service must run as the selected non-root account. Root-run services need a separate ownership migration.")
    if scope == "user" and owner not in ("", account.pw_name, str(account.pw_uid)):
        fail("The user service belongs to a different account.")
    primary_group = str(account.pw_gid)
    if properties.get("Group", "") not in ("", primary_group):
        import grp
        if properties["Group"] != grp.getgrgid(account.pw_gid).gr_name:
            fail("Custom service groups require manual review.")
    if properties.get("SupplementaryGroups", "").strip():
        fail("Custom supplementary service groups require manual review.")
    if properties.get("EnvironmentFiles", "").strip():
        fail("Services using EnvironmentFiles need a reviewed manual conversion. No settings were changed.")
    if properties.get("Type", "simple") not in ("simple", "exec"):
        fail("Only simple or exec services can be converted automatically.")
    if properties.get("KillMode", "control-group") != "control-group":
        fail("The service must stop its complete control group before conversion.")
    if properties.get("DynamicUser", "no") not in ("no", "false", ""):
        fail("DynamicUser services require manual migration.")
    if properties.get("RootDirectory", "") not in ("", "/") or properties.get("RootImage", ""):
        fail("Containerized or chrooted systemd services require manual migration.")
    if any(properties.get(key, "").strip() for key in ("ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost")):
        fail("Custom service start/stop hooks require manual review.")
    command = properties.get("ExecStart", "")
    if not command or command.count("{") != 1:
        fail("A single BlackDogBot ExecStart command is required.")
    match = re.search(r"argv\[\]=(.*?)\s*;", command)
    if not match:
        fail("Cannot inspect the service start command safely.")
    arguments = shlex.split(match.group(1))
    allowed = any(
        item.endswith("/scripts/launch.sh") or item.endswith("/src/index.ts") or item.endswith("/dist/index.js")
        or item == "src/index.ts" or item.endswith("/blackdogbot/launch-stable.sh")
        or item.endswith("/blackdogbot/launch-upgrade.py")
        for item in arguments
    )
    if not allowed and len(arguments) == 2:
        allowed = Path(arguments[0]).name in ("pnpm", "npm") and arguments[1] in ("start", "start:direct")
    if not allowed or any(item in ("-c", "-lc", "--eval", "-e") for item in arguments):
        fail("The service uses a custom command. Review it before automatic conversion.")
    declared_environment(properties)


def discover_service(scope: str, unit: str | None, account) -> dict:
    candidates = []
    for name in ([unit] if unit else ["blackdogbot.service", "betterclaw.service"]):
        for candidate_scope in (["user", "system"] if scope == "auto" else [scope]):
            properties = unit_properties(candidate_scope, name)
            if unit_exists(properties) and (properties.get("LoadState") != "masked" or scope != "auto"):
                candidates.append((candidate_scope, name, properties))
    if len(candidates) != 1:
        fail("Service selection is ambiguous or missing. Supply --scope user|system and --unit NAME.service.")
    selected_scope, name, properties = candidates[0]
    if properties.get("LoadState") == "masked":
        fail("The selected service is masked. Resume its saved upgrade with recover or apply --state.")
    validate_simple_unit(properties, selected_scope, account)
    pid = int(properties.get("MainPID", "0"))
    runtime_pid = runtime_process_pid(pid, account.pw_uid) if pid else 0
    if runtime_pid:
        try:
            runtime_cwd = str((Path("/proc") / str(runtime_pid) / "cwd").resolve(strict=True))
            runtime_node = str((Path("/proc") / str(runtime_pid) / "exe").resolve(strict=True))
            source_entry = runtime_source_entry(runtime_pid, Path(runtime_cwd))
        except OSError:
            fail("Cannot verify the running bot working directory and Node executable.")
    else:
        runtime_cwd = stopped_runtime_cwd(properties)
        runtime_node = shutil.which("node")
        source_entry = stopped_source_entry(properties)
    if not runtime_cwd:
        fail("The service has no verified working directory. Supply a reviewed service configuration.")
    files = unit_files(properties)
    if selected_scope == "system":
        inspect_system_unit_files(files)
    environment = declared_environment(properties)
    running_environment = process_environment(runtime_pid)
    for key in ("HOME", "PATH", "BLACKDOGBOT_DATA_DIR", "LD_LIBRARY_PATH", "NODE_ENV"):
        if key in running_environment:
            environment[key] = running_environment[key]
    return {"scope": selected_scope, "unit": name, "properties": properties, "files": files,
            "fingerprint": fingerprint(properties, files), "runtimeCwd": runtime_cwd, "runtimeNode": runtime_node, "runtimeSourceEntry": str(source_entry),
            "environment": environment, "processSettings": system_service_settings({"files": files, "properties": properties}) if selected_scope == "system" else None,
            "owner": account.pw_name, "uid": account.pw_uid,
            "wasActive": properties.get("ActiveState") == "active",
            "wasEnabled": properties.get("UnitFileState") == "enabled"}


def ensure_no_competing_service(service: dict, *, converted: bool = False) -> None:
    for unit in set((service["unit"], "blackdogbot.service", "betterclaw.service")):
        for scope in ("user", "system"):
            if (scope, unit) == (service["scope"], service["unit"]):
                continue
            if converted and scope == "user" and unit == service["unit"]:
                continue
            properties = unit_properties(scope, unit)
            if not unit_exists(properties) or properties.get("LoadState") == "masked":
                continue
            if int(properties.get("MainPID", "0")) or properties.get("ActiveState") in ("active", "activating", "deactivating") or properties.get("UnitFileState") in ("enabled", "enabled-runtime"):
                fail("Another bot service can run concurrently: " + scope + " " + unit + ". Stop and disable the duplicate before upgrading.")


def find_repository(explicit: Path | None, service: dict, state: Path | None = None) -> Path:
    candidates = []
    if explicit:
        candidates.append(explicit)
    elif os.environ.get("BLACKDOGBOT_SOURCE_DIR"):
        candidates.append(Path(os.environ["BLACKDOGBOT_SOURCE_DIR"]))
    else:
        if state and (state / "source-repository.json").is_file():
            saved = read_json(state / "source-repository.json").get("path")
            if isinstance(saved, str):
                candidates.append(Path(saved))
        candidates.extend([Path(service["runtimeCwd"]), Path(__file__).resolve().parent.parent,
                           Path.home() / ".local/share/blackdogbot/source"])
    for base in candidates:
        for candidate in [base, *base.parents]:
            try:
                if json.loads((candidate / "package.json").read_text()).get("name") != "blackdogbot":
                    continue
                common = run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=candidate).stdout.strip()
                source = Path(common).parent if Path(common).name == ".git" else candidate
                if (source / ".git").exists():
                    return source.resolve()
            except (OSError, ValueError, UpgradeError):
                continue
        if explicit:
            break
    fail("Source checkout not found. Supply --repo /absolute/path/to/BlackDogBot.")


def data_directory(explicit: Path | None, service: dict, account) -> Path:
    configured = service["environment"].get("BLACKDOGBOT_DATA_DIR")
    if explicit:
        result = absolute(explicit, "--data-dir")
        if configured and result != absolute(configured, "Service data directory"):
            fail("The selected data directory differs from the running service environment.")
    elif configured:
        result = absolute(configured, "Service data directory")
    else:
        choices = [Path(account.pw_dir) / name for name in (".blackdogbot", ".betterclaw")]
        choices = [path for path in choices if (path / "config.yaml").is_file()]
        if len(choices) != 1:
            fail("Data location is ambiguous. Supply --data-dir after reviewing the existing configuration.")
        result = choices[0]
    for path in (result, result / "config.yaml"):
        safe_path(path)
        if path.stat().st_uid != account.pw_uid:
            fail("The data directory and configuration must belong to the service account. No ownership was changed.")
    return result


def canonical_origin(repo: Path) -> bool:
    origin = run(["git", "remote", "get-url", "origin"], cwd=repo).stdout.strip()
    return origin.lower().rstrip("/").removesuffix(".git") in (
        "git@github.com:mistrjirka/blackdogbot",
        "https://github.com/mistrjirka/blackdogbot",
        "ssh://git@github.com/mistrjirka/blackdogbot",
    )


def latest_release() -> str:
    request = urllib.request.Request("https://api.github.com/repos/" + PROJECT + "/releases/latest",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": "BlackDogBot-upgrade"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            release = json.load(response)
    except Exception:
        fail("Latest stable release could not be resolved. Supply an explicit reviewed tag or full commit SHA.")
    tag = release.get("tag_name", "")
    if release.get("draft") or release.get("prerelease") or not TAG.fullmatch(tag) or "-" in tag:
        fail("The published release is not a supported stable version.")
    return tag


def resolve_revision(repo: Path, requested: str | None) -> tuple[str, str]:
    if requested is None:
        if not canonical_origin(repo):
            fail("A nonstandard origin needs an explicit reviewed tag or full commit SHA.")
        requested = latest_release()
    if SHA.fullmatch(requested):
        return requested, requested
    if not TAG.fullmatch(requested):
        fail("--revision must be a version tag or a full 40-character commit SHA. Moving branches are not accepted.")
    output = run(["git", "ls-remote", "--tags", "origin", "refs/tags/" + requested, "refs/tags/" + requested + "^{}"], cwd=repo).stdout
    refs = dict(line.split("\t", 1)[::-1] for line in output.splitlines() if "\t" in line)
    revision = refs.get("refs/tags/" + requested + "^{}") or refs.get("refs/tags/" + requested)
    if not revision or not SHA.fullmatch(revision):
        fail("The requested version tag was not found on origin.")
    return requested, revision


def git_revision(repo: Path) -> str:
    value = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
    if not SHA.fullmatch(value):
        fail("Cannot identify the source commit.")
    return value


def snapshot_matches(files: list[dict]) -> bool:
    try:
        return all(file_snapshot(Path(item["path"])) == item for item in files)
    except (OSError, UpgradeError):
        return False


def prepared(release: Path, revision: str) -> bool:
    try:
        return (release / ".blackdog-release-tested").read_text().strip() == revision and git_revision(release) == revision and not run(
            ["git", "status", "--porcelain", "--untracked-files=no"], cwd=release).stdout.strip()
    except (OSError, UpgradeError):
        return False


def check_runtime() -> None:
    result = run(["node", "--version"]).stdout.strip()
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", result)
    if not match or tuple(map(int, match.groups())) < (22, 13, 0):
        fail("Node.js 22.13.0 or newer is required. Update Node before upgrading BlackDogBot.")
    if not shutil.which("pnpm"):
        fail("pnpm is required. Install the exact version declared by the selected release.")


def prepare_candidate(repo: Path, state: Path, revision: str, reference: str, log: Path) -> Path:
    release = state / "releases" / revision
    if prepared(release, revision):
        return release
    if release.exists():
        if git_revision(release) != revision or run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=release).stdout.strip():
            fail("An existing candidate contains different or edited source. Preserve it and inspect before retrying.")
    else:
        run(["git", "fetch", "--no-tags", "origin", reference], cwd=repo, timeout=180, log=log)
        actual = run(["git", "rev-parse", "FETCH_HEAD^{commit}"], cwd=repo).stdout.strip()
        if actual != revision:
            fail("The requested tag changed after planning. Review the new commit before retrying.")
        release.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "worktree", "add", "--detach", str(release), revision], cwd=repo, log=log)
    package = json.loads((release / "package.json").read_text())
    declared = package.get("packageManager", "")
    if not re.fullmatch(r"pnpm@[0-9]+\.[0-9]+\.[0-9]+", declared):
        fail("The selected release does not declare an exact pnpm version.")
    actual = run(["pnpm", "--version"], cwd=release).stdout.strip()
    if actual != declared[5:]:
        fail("Install " + declared + " before continuing this upgrade.")
    validation_env = {"BLACKDOGBOT_DATA_DIR": str(state / "validation-unselected"),
                      "BLACKDOGBOT_MODELS_DIR": str(state / "validation-models"),
                      "BLACKDOGBOT_TEST_LIVE_MODEL": "0", "BLACKDOGBOT_RUN_LIVE_PROMPT_AUDIT": "0",
                      "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    for argv, timeout in (
        (["pnpm", "install", "--frozen-lockfile"], 900),
        (["pnpm", "typecheck"], 180),
        (["pnpm", "test:fast"], 900),
        (["python3", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"], 180),
        (["pnpm", "build"], 180),
    ):
        run(argv, cwd=release, timeout=timeout, log=log, env=validation_env)
    atomic_write(release / ".blackdog-release-tested", (revision + "\n").encode())
    return release


def load_guard(candidate: Path):
    source = candidate / "scripts/guarded-release.py"
    spec = importlib.util.spec_from_file_location("blackdogbot_candidate_guard_" + uuid.uuid4().hex, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    signature = inspect.signature(module.activate)
    if not {"runtime_cwd", "database_source"}.issubset(signature.parameters):
        fail("The selected release lacks the supported upgrade protocol.")
    return module


def save_operation(state: Path, operation: dict) -> None:
    directory = state / "upgrades" / operation["id"]
    private_directory(directory)
    write_json(directory / "journal.json", operation)
    write_json(state / "upgrades/latest.json", {"operation": str(directory / "journal.json")})


def load_operation(state: Path) -> dict | None:
    pointer = state / "upgrades/latest.json"
    if not pointer.exists():
        return None
    journal = Path(read_json(pointer).get("operation", ""))
    if not journal.is_absolute() or journal.parent.parent != state / "upgrades" or journal.name != "journal.json":
        fail("Upgrade journal pointer is invalid.")
    operation = read_json(journal)
    if operation.get("formatVersion") != 1 or operation.get("state") != str(state):
        fail("Upgrade journal is incompatible.")
    return operation


def save_owned_file(operation: dict, file: Path, content: bytes, mode: int = 0o600,
                    *, require_absent: bool = False) -> None:
    safe_path(file, absent=True)
    saved = next((item for item in operation.get("files", []) if item["path"] == str(file)), None)
    if saved:
        if saved["afterSha256"] != digest(content):
            fail("The resumed upgrade would produce different service files.")
        current = file.read_bytes() if file.exists() else None
        before = bytes.fromhex(saved["before"]) if saved["before"] is not None else None
        if current == content:
            return
        if current != before:
            fail("A managed service file changed after preparation. Preserve the new edit before retrying.")
        atomic_write(file, content, mode)
        return
    if file.exists():
        if require_absent:
            fail("An existing service file will not be overwritten: " + str(file))
        before = file.read_bytes()
        previous_mode = stat.S_IMODE(file.stat().st_mode)
    else:
        before = None
        previous_mode = None
    item = {"path": str(file), "before": before.hex() if before is not None else None,
            "beforeMode": previous_mode, "afterSha256": digest(content)}
    operation.setdefault("files", []).append(item)
    save_operation(Path(operation["state"]), operation)
    atomic_write(file, content, mode)


def restore_owned_files(operation: dict, *, exclude: set[str] | None = None) -> None:
    for item in reversed(operation.get("files", [])):
        if exclude and item["path"] in exclude:
            continue
        file = Path(item["path"])
        safe_path(file, absent=True)
        before = bytes.fromhex(item["before"]) if item["before"] is not None else None
        if file.exists():
            current = file.read_bytes()
            if digest(current) not in (item["afterSha256"], digest(before) if before is not None else ""):
                fail("A managed service file changed after upgrade. Restoration would overwrite a newer edit.")
        elif before is not None:
            fail("A managed service file disappeared after upgrade. Inspect its backup before restoring.")
        if before is None:
            file.unlink(missing_ok=True)
            if file.parent.exists():
                sync_dir(file.parent)
        else:
            atomic_write(file, before, item["beforeMode"])


def refresh_supervisor(operation: dict, candidate: Path, account) -> Path:
    target = Path(account.pw_dir) / ".local/lib/blackdogbot/guarded-release.py"
    save_owned_file(operation, target, (candidate / "scripts/guarded-release.py").read_bytes(), 0o700)
    return target


def prepare_baseline(operation: dict, log: Path) -> Path:
    repo = Path(operation.get("baselineRepo", operation["repo"]))
    revision = operation["previousRevision"]
    baseline = Path(operation["state"]) / "legacy-baselines" / revision
    marker = baseline / ".blackdog-legacy-baseline.json"
    if marker.is_file():
        saved = read_json(marker)
        if git_revision(baseline) != revision or run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=baseline).stdout.strip():
            fail("The preserved baseline source changed. Inspect it before continuing.")
        if saved.get("revision") != revision or saved.get("runtimeCwd") != operation["service"]["runtimeCwd"]:
            fail("A preserved baseline has different source or runtime paths.")
        return baseline
    if not snapshot_matches(operation["service"]["files"]):
        fail("The original service configuration changed during preparation.")
    if git_revision(repo) != revision or run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo).stdout.strip():
        fail("The direct-service checkout changed. Commit or preserve its changes before conversion.")
    baseline.parent.mkdir(parents=True, exist_ok=True)
    if baseline.exists():
        if git_revision(baseline) != revision or run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=baseline).stdout.strip():
            fail("An existing baseline contains different or edited source.")
    else:
        run(["git", "worktree", "add", "--detach", str(baseline), revision], cwd=repo, log=log)
    run(["pnpm", "install", "--frozen-lockfile"], cwd=baseline, timeout=900, log=log)
    if not (baseline / "src/index.ts").is_file() or not (baseline / "node_modules/.bin/tsx").is_file():
        fail("The previous checkout does not use the supported TypeScript launch layout.")
    previous_env = {key: value for key, value in operation["service"]["environment"].items()
                    if key in ("LD_LIBRARY_PATH", "PATH", "HOME", "BLACKDOGBOT_DATA_DIR", "NODE_ENV")}
    write_json(marker, {"revision": revision, "runtimeCwd": operation["service"]["runtimeCwd"],
                        "node": operation["service"].get("runtimeNode") or shutil.which("node"), "environment": previous_env,
                        "kind": "preserved-source", "fullTestsRun": False})
    return baseline


def launcher_content(state: Path) -> bytes:
    # Baseline source is pinned, but relative data paths must retain the ORIGINAL
    # working directory. launch.sh normally changes cwd to the release directory.
    return ("""#!/usr/bin/env python3
import json, os
from pathlib import Path
state = Path(%r)
release = (state / "current").resolve(strict=True)
baseline = release / ".blackdog-legacy-baseline.json"
if baseline.is_file():
    data = json.loads(baseline.read_text())
    environment = os.environ.copy()
    environment.update(data["environment"])
    os.chdir(data["runtimeCwd"])
    os.execve(data["node"], [data["node"], str(release / "node_modules/tsx/dist/cli.mjs"), str(release / "src/index.ts")], environment)
os.execv("/usr/bin/bash", ["bash", str(release / "scripts/launch.sh")])
""" % str(state)).encode()


def unit_quote(value: str) -> str:
    if any(ord(character) < 32 for character in value):
        fail("A service setting contains an unsupported control character.")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'


def system_service_settings(service: dict) -> str:
    if service.get("processSettings") is not None:
        return service["processSettings"]
    keys = {"Type", "Restart", "RestartSec", "KillSignal", "TimeoutStopSec"}
    settings = {}
    for item in service["files"]:
        section = None
        for raw in Path(item["path"]).read_text().splitlines():
            line = raw.strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
                continue
            key, separator, value = line.partition("=")
            if section == "Service" and separator and key in keys and value:
                settings[key] = value
    for setting, property_name in (("Type", "Type"), ("Restart", "Restart"), ("RestartSec", "RestartUSec"), ("KillSignal", "KillSignal"), ("TimeoutStopSec", "TimeoutStopUSec")):
        if service["properties"].get(property_name):
            settings[setting] = service["properties"][property_name]
    if any(any(ord(character) < 32 for character in value) for value in settings.values()):
        fail("The original service has an unsupported process setting.")
    return "".join(key + "=" + value + "\n" for key, value in sorted(settings.items()))


def install_launcher(operation: dict, baseline: Path, account) -> None:
    state = Path(operation["state"])
    current = state / "current"
    service = operation["service"]
    wrapper = Path(account.pw_dir) / ".local/lib/blackdogbot/launch-upgrade.py"
    unit_dir = Path(account.pw_dir) / ".config/systemd/user"
    unit = service["unit"]
    if current.exists() or current.is_symlink():
        if not current.is_symlink() or current.resolve() != baseline or not operation.get("launcherInstalling"):
            fail("A release pointer already exists. Recover the previous conversion before replacing it.")
    operation["launcherInstalling"] = True
    operation["baseline"] = str(baseline)
    save_operation(state, operation)
    save_owned_file(operation, wrapper, launcher_content(state), 0o700)
    node_directory = str(Path(shutil.which("node")).parent)
    environment = dict(service["environment"]) if service["scope"] == "system" else {}
    environment.update({"HOME": account.pw_dir, "BLACKDOGBOT_DATA_DIR": operation["dataDir"],
                        "PATH": str(Path(account.pw_dir) / ".local/bin") + ":" + node_directory + ":" + service["environment"].get("PATH", os.defpath)})
    environment_text = "".join("Environment=" + unit_quote(key + "=" + value) + "\n" for key, value in sorted(environment.items()))
    if service["scope"] == "system":
        target = unit_dir / unit
        if not operation.get("launcherInstalled") and unit_exists(unit_properties("user", unit)) and not any(item["path"] == str(target) for item in operation.get("files", [])):
            fail("A user service already exists. It will not be overwritten during system-service conversion.")
        text = ("[Unit]\nDescription=BlackDogBot AI assistant\nAfter=network-online.target\nWants=network-online.target\n\n"
                "[Service]\n" + system_service_settings(service) + "WorkingDirectory=" + unit_quote(str(current)) + "\n" + environment_text +
                "ExecStart=" + unit_quote(sys.executable) + " " + unit_quote(str(wrapper)) +
                "\n\n[Install]\nWantedBy=default.target\n")
    else:
        target = unit_dir / (unit + ".d") / "40-guarded-release.conf"
        text = "[Service]\nExecStart=\nExecStart=" + unit_quote(sys.executable) + " " + unit_quote(str(wrapper)) + "\nWorkingDirectory=" + unit_quote(str(current)) + "\n" + environment_text
    save_owned_file(operation, target, text.encode(), require_absent=True)
    if not current.is_symlink():
        current.symlink_to(baseline)
        sync_dir(state)
    systemctl("user", "daemon-reload")
    if service["scope"] == "system" and service["wasEnabled"]:
        systemctl("user", "enable", unit)
    operation["launcherInstalled"] = True
    operation["phase"] = "launcher_prepared"
    save_operation(state, operation)


def admin_command(operation: dict, action: str) -> list[str]:
    service = operation["service"]
    script = Path(operation["candidate"]) / "scripts/upgrade.py"
    result = ["sudo", "/usr/bin/python3", str(script), action, "--unit", service["unit"],
              "--owner", service["owner"]]
    if action == "system-release":
        result += ["--fingerprint", service["fingerprint"], "--candidate", operation["candidate"],
                   "--baseline", operation["baseline"], "--data-dir", operation["dataDir"]]
    elif service["wasActive"]:
        result.append("--start")
    return result


def system_released(operation: dict) -> bool:
    service = operation["service"]
    properties = unit_properties("system", service["unit"])
    return mask_is_expected(SYSTEM_DIR / service["unit"]) and properties.get("LoadState") == "masked" and int(properties.get("MainPID", "0")) == 0 and properties.get("ActiveState") in ("inactive", "failed")


def public_operation(operation: dict) -> dict:
    service = operation["service"]
    result = {"protocolVersion": 1, "status": operation.get("phase", "planned"),
              "revision": operation["revision"], "requestedRevision": operation["reference"],
              "repo": operation["repo"], "dataDir": operation["dataDir"], "state": operation["state"],
              "unit": service["unit"], "serviceScope": service["scope"],
              "runtimeCwd": service["runtimeCwd"], "owner": service["owner"],
              "previousRevision": operation["previousRevision"], "previousRuntimeRepo": operation.get("baselineRepo"),
              "environmentKeys": sorted(service["environment"]), "guarded": operation["guarded"]}
    result["candidatePath"] = str(Path(operation["state"]) / "releases" / operation["revision"])
    result["administratorRequired"] = service["scope"] == "system"
    result["plannedChanges"] = ["Prepare and test the selected commit before stopping the bot", "Refresh the independent supervisor with a private original copy", "Run guarded backup, migration, staged startup, and acceptance"]
    if not operation["guarded"]:
        result["plannedChanges"].append("Preserve previous source and its original runtime directory")
        result["plannedChanges"].append("Install a user-service launcher without replacing existing configuration")
    if service["scope"] == "system":
        result["plannedChanges"].append("Administrator: preserve, stop, disable, and mask the original system unit")
        if service["wasEnabled"]:
            result["plannedChanges"].append("Administrator: enable user lingering only if needed to preserve startup at boot")
    if operation.get("phase") == "administrator_required":
        result["administratorCommand"] = shlex.join(admin_command(operation, "system-release"))
        result["nextCommand"] = shlex.join(["python3", str(Path(operation["candidate"]) / "scripts/upgrade.py"), "apply", "--state", operation["state"]])
    if operation.get("phase") == "administrator_restore_required":
        result["administratorCommand"] = shlex.join(admin_command(operation, "system-restore"))
    if operation.get("id"):
        result["recoveryCommand"] = shlex.join(["python3", str(Path(operation.get("candidate", operation["repo"])) / "scripts/upgrade.py"), "recover", "--state", operation["state"]])
        result["journal"] = str(Path(operation["state"]) / "upgrades" / operation["id"] / "journal.json")
    return result


def build_plan(args, account) -> dict:
    service = discover_service(args.scope, args.unit, account)
    ensure_no_competing_service(service)
    data = data_directory(args.data_dir, service, account)
    state = absolute(args.state, "--state") if args.state else data / "deploy"
    safe_path(state, absent=True)
    repo = find_repository(args.repo, service, state)
    if service["environment"].get("HOME", account.pw_dir) != account.pw_dir:
        fail("The service HOME differs from its account. Review data discovery before conversion.")
    reference, revision = resolve_revision(repo, args.revision)
    current = state / "current"
    guarded = current.is_symlink() and service["scope"] == "user"
    if current.exists() and not current.is_symlink():
        fail("The guarded current path is not a symlink.")
    if guarded:
        working = Path(service["properties"].get("WorkingDirectory", ""))
        if working != current:
            fail("The existing release pointer does not match the service working directory.")
        previous_revision = current.resolve().name
    else:
        baseline_repo = runtime_repository(service)
        previous_revision = args.previous_revision or git_revision(baseline_repo)
        if not SHA.fullmatch(previous_revision):
            fail("--previous-revision must be a full commit SHA.")
        if previous_revision != git_revision(baseline_repo):
            fail("The direct-service checkout must match the reviewed previous revision. Preserve or restore its source before conversion.")
        if run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=baseline_repo).stdout.strip():
            fail("Direct-service source has uncommitted tracked changes. Preserve them before conversion.")
    runtime = absolute(args.runtime_cwd, "--runtime-cwd") if args.runtime_cwd else Path(service["runtimeCwd"])
    if int(service["properties"].get("MainPID", "0")) and runtime != Path(service["runtimeCwd"]):
        fail("--runtime-cwd differs from the running service process.")
    service["runtimeCwd"] = str(runtime)
    return {"formatVersion": 1, "phase": "planned", "repo": str(repo), "dataDir": str(data),
            "state": str(state), "reference": reference, "revision": revision,
            "previousRevision": previous_revision, "previousPath": str(current.resolve()) if guarded else None,
            "baselineRepo": str(baseline_repo) if not guarded else None, "service": service, "guarded": guarded,
            "databaseSource": str(absolute(args.database_source, "--database-source")) if args.database_source else None,
            "importLegacyTasks": args.import_legacy_tasks, "timeout": args.timeout}


def latest_guard_report(state: Path) -> dict:
    try:
        return read_json(state / "reports/latest.json")
    except (OSError, ValueError, UpgradeError):
        return {}


def verify_original_checkout(operation: dict) -> None:
    repo = Path(operation.get("baselineRepo") or operation["repo"])
    if git_revision(repo) != operation["previousRevision"] or run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo).stdout.strip():
        fail("The original checkout changed. Keep the preserved baseline running until its source is reviewed.")


def apply_operation(operation: dict, account) -> dict:
    state = Path(operation["state"])
    private_directory(state)
    private_directory(state / "upgrades")
    private_directory(state / "reports")
    if operation["phase"] == "administrator_restore_required":
        fail("Finish the recorded system-service restoration, then run recover before starting another upgrade.")
    if not operation.get("id"):
        operation["id"] = "u-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex
        save_operation(state, operation)
    log = state / "upgrades" / operation["id"] / "prepare.log"
    with (state / "deploy.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        ensure_no_competing_service(operation["service"], converted=operation.get("launcherInstalling", False))
        manager = systemctl("user", "show-environment", check=False)
        if manager.returncode:
            fail("The service account's systemd user manager is unavailable. Start a login session for that account and retry. System-service conversion also needs its user manager.")
        check_runtime()
        candidate = prepare_candidate(Path(operation["repo"]), state, operation["revision"], operation["reference"], log)
        guard = load_guard(candidate)
        operation["candidate"] = str(candidate)
        if operation["phase"] in ("planned", "candidate_prepared"):
            operation["phase"] = "candidate_prepared"
        save_operation(state, operation)
        if not operation["guarded"] and not operation.get("baseline"):
            baseline = prepare_baseline(operation, log)
            operation["baseline"] = str(baseline)
            operation["previousPath"] = str(baseline)
            save_operation(state, operation)
        if operation["service"]["scope"] == "system" and not system_released(operation):
            if operation.get("launcherInstalling"):
                fail("The original system service is no longer masked. Stop both services and inspect the saved conversion before retrying.")
            if not snapshot_matches(operation["service"]["files"]):
                fail("The system service configuration changed. Generate a new plan before administrative conversion.")
            operation["phase"] = "administrator_required"
            save_operation(state, operation)
            return operation
        refresh_supervisor(operation, candidate, account)
        if not operation["guarded"] and not operation.get("launcherInstalled"):
            if operation["service"]["scope"] == "user" and not snapshot_matches(operation["service"]["files"]):
                fail("The service configuration changed during preparation.")
            verify_original_checkout(operation)
            install_launcher(operation, Path(operation["baseline"]), account)
        if operation["service"]["scope"] == "system" and not system_released(operation):
            fail("The original system service must remain masked before user-service activation.")
        operation["phase"] = "activating"
        save_operation(state, operation)
        try:
            healthy = guard.activate(
                state, operation["service"]["unit"], operation["revision"], None,
                timeout=operation["timeout"], update_containers=False, data_dir=Path(operation["dataDir"]),
                runtime_cwd=Path(operation["service"]["runtimeCwd"]),
                database_source=Path(operation["databaseSource"]) if operation.get("databaseSource") else None,
                import_legacy_tasks=operation.get("importLegacyTasks", False))
        except Exception:
            operation["phase"] = "activation_interrupted"
            save_operation(state, operation)
            raise
        result = latest_guard_report(state)
        if healthy:
            operation["phase"] = "healthy"
        elif result.get("status") == "rolled_back":
            operation["phase"] = "rolled_back"
        else:
            operation["phase"] = "recovery_required"
        operation["deploymentStatus"] = result.get("status", "unknown")
        save_operation(state, operation)
    return operation


def safe_to_restore(operation: dict, report: dict) -> bool:
    if operation["phase"] in ("planned", "candidate_prepared", "administrator_required", "launcher_prepared", "administrator_restore_required"):
        return True
    if report.get("manual_recovery_required") or report.get("path_recovery_error"):
        return False
    if report.get("revision", report.get("failed_revision")) != operation["revision"]:
        return False
    if report.get("status") == "rolled_back":
        return True
    return report.get("status") in ("preflight_failed", "backup_failed", "stop_failed") and report.get("data_unchanged") is True


def recover_operation(operation: dict, account) -> dict:
    if operation["phase"] == "restored":
        return operation
    state = Path(operation["state"])
    service = operation["service"]
    if not operation.get("candidate"):
        if operation.get("files") or operation.get("launcherInstalling"):
            fail("An incomplete conversion has no verified candidate. Preserve its journal for manual inspection.")
        operation["phase"] = "restored"
        save_operation(state, operation)
        return operation
    candidate = Path(operation["candidate"])
    guard = load_guard(candidate)
    baseline = Path(operation.get("previousPath") or operation.get("baseline") or (state / "current").resolve())
    with (state / "deploy.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with guard.activation_lock(Path(operation["dataDir"])):
            return recover_locked(operation, account, guard, baseline, candidate)


def recover_locked(operation: dict, account, guard, baseline: Path, candidate: Path) -> dict:
    state = Path(operation["state"])
    service = operation["service"]
    if not safe_to_restore(operation, latest_guard_report(state)):
        fail("Data recovery must finish before service conversion can be undone. Inspect the guarded deployment report.")
    activation = guard.read_activation(Path(operation["dataDir"]))
    if activation and (activation.get("status") == "pending" or activation.get("candidatePath") == str(candidate)):
        fail("The candidate has a pending or accepted activation. Resume it or complete explicit data recovery before restoring old code.")
    current = state / "current"
    if current.is_symlink() and current.resolve() != baseline:
        fail("The current pointer does not select the restored baseline. Data recovery must finish first.")
    guard.can_start_release(baseline, Path(operation["dataDir"]))
    if operation["guarded"]:
        if not current.is_symlink():
            fail("The previous release pointer is missing.")
        if service["wasActive"]:
            systemctl("user", "start", service["unit"])
        operation["phase"] = "restored"
        save_operation(state, operation)
        return operation
    if operation.get("launcherInstalling"):
        guard.stop_and_verify(service["unit"])
    if service["scope"] == "user":
        if not snapshot_matches(service["files"]):
            fail("The original service configuration changed. Preserve both versions before recovery.")
        verify_original_checkout(operation)
    if service["scope"] == "system":
        systemctl("user", "disable", service["unit"], check=False)
    supervisor = str(Path(account.pw_dir) / ".local/lib/blackdogbot/guarded-release.py")
    restore_owned_files(operation, exclude={supervisor})
    if current.is_symlink():
        current.unlink()
        sync_dir(state)
    systemctl("user", "daemon-reload")
    if service["scope"] == "system" and system_released(operation):
        operation["phase"] = "administrator_restore_required"
    else:
        if service["scope"] == "system":
            if not snapshot_matches(service["files"]):
                fail("The system service has not been restored. Use the recorded administrator restore command.")
        elif service["wasActive"]:
            systemctl("user", "start", service["unit"])
        operation["phase"] = "restored"
    save_operation(state, operation)
    return operation


def root_command(name: str) -> str:
    result = shutil.which(name, path="/usr/sbin:/usr/bin:/sbin:/bin")
    if not result:
        fail("Required system command is unavailable: " + name)
    return result


def run_as_owner(account, argv: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    environment = ["XDG_RUNTIME_DIR=/run/user/" + str(account.pw_uid),
                   "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + str(account.pw_uid) + "/bus"]
    return run([root_command("runuser"), "-u", account.pw_name, "--",
                root_command("env"), *environment, *argv], timeout=90, check=check)


def admin_receipt(unit: str) -> Path:
    if not UNIT.fullmatch(unit):
        fail("Invalid service unit name.")
    return ADMIN_DIR / unit / "receipt.json"


def inspect_system_unit_files(files: list[dict]) -> None:
    allowed = {
        "Unit": {"Description", "After", "Wants", "Documentation"},
        "Service": {"Type", "User", "Group", "WorkingDirectory", "ExecStart", "Environment", "UnsetEnvironment", "Restart", "RestartSec", "KillSignal", "TimeoutStopSec"},
        "Install": {"WantedBy"},
    }
    for item in files:
        path = Path(item["path"])
        info = path.stat()
        if info.st_uid != ROOT_UID or info.st_mode & 0o022:
            fail("System unit files must be administrator-owned and not writable by other users.")
        section = None
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line.endswith("\\"):
                fail("System-unit continuations need a reviewed manual conversion.")
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
                if section not in allowed:
                    fail("An unsupported system-unit section needs manual conversion.")
                continue
            key, equal, value = line.partition("=")
            if section == "Unit" and key.strip() in ("After", "Wants") and not set(value.split()).issubset({"network.target", "network-online.target"}):
                fail("Custom system-unit dependencies cannot be transferred safely to a user manager.")
            if not equal or key.strip() not in allowed.get(section, set()):
                fail("An unsupported system-unit setting needs manual conversion: " + key.strip())


def mask_is_expected(mask: Path) -> bool:
    return mask.is_symlink() and os.readlink(mask) == "/dev/null" and mask.lstat().st_uid == ROOT_UID


def original_system_files_intact(receipt: dict, *, allow_mask: bool = False) -> bool:
    for item in receipt["files"]:
        path = Path(item["path"])
        if allow_mask and str(path) == receipt.get("localUnit") and mask_is_expected(path):
            continue
        try:
            if file_snapshot(path) != item:
                return False
        except (OSError, UpgradeError):
            return False
    return True


def original_unit_visible(receipt: dict, mask: Path) -> bool:
    return original_system_files_intact(receipt) and (receipt.get("localUnit") == str(mask) or not (mask.exists() or mask.is_symlink()))


def administrator_release(args, account, receipt_path: Path, mask: Path) -> dict:
    if receipt_path.exists():
        receipt = read_json(receipt_path)
        if receipt.get("owner") != account.pw_name or receipt.get("fingerprint") != args.fingerprint or receipt.get("candidate") != str(args.candidate) or receipt.get("baseline") != str(args.baseline) or receipt.get("dataDir") != str(args.data_dir):
            fail("A different system-service conversion is already recorded.")
        if receipt.get("phase") in ("restoring", "restored"):
            fail("This conversion was restored. Review a new upgrade plan before releasing the system service again.")
    else:
        properties = unit_properties("system", args.unit)
        validate_simple_unit(properties, "system", account)
        files = unit_files(properties)
        if fingerprint(properties, files) != args.fingerprint:
            fail("The system unit changed after planning. Review a new plan before stopping it.")
        if properties.get("UnitFileState") not in ("enabled", "disabled"):
            fail("Only enabled or disabled regular system units are supported.")
        fragment = Path(properties["FragmentPath"])
        if fragment.name != args.unit or fragment.parent not in (SYSTEM_DIR, Path("/usr/lib/systemd/system"), Path("/lib/systemd/system")):
            fail("The system unit is not in a supported regular unit location.")
        inspect_system_unit_files(files)
        data = absolute(args.data_dir, "--data-dir")
        candidate = absolute(args.candidate, "--candidate")
        baseline = absolute(args.baseline, "--baseline")
        for path in (data, data / "config.yaml", candidate, baseline):
            safe_path(path)
            if path.stat().st_uid != account.pw_uid:
                fail("Application files must belong to the selected service account.")
        linger = run([root_command("loginctl"), "show-user", account.pw_name, "-p", "Linger", "--value"], check=False)
        if linger.returncode or linger.stdout.strip() not in ("yes", "no"):
            fail("Cannot verify the service account's boot behavior with loginctl. Open its login session before conversion.")
        receipt = {"formatVersion": 1, "owner": account.pw_name, "uid": account.pw_uid,
                   "unit": args.unit, "fingerprint": args.fingerprint, "files": files,
                   "wasActive": properties.get("ActiveState") == "active",
                   "wasEnabled": properties.get("UnitFileState") == "enabled",
                   "lingerWasEnabled": linger.stdout.strip() == "yes",
                   "candidate": str(candidate), "baseline": str(baseline), "dataDir": str(data),
                   "localUnit": str(mask) if fragment == mask else None,
                   "phase": "prepared"}
        if mask.exists() and fragment != mask or mask.is_symlink():
            fail("The system mask location already contains a different file.")
        if fragment == mask:
            receipt["localUnitMode"] = stat.S_IMODE(mask.stat().st_mode)
            receipt["localUnitUid"] = mask.stat().st_uid
            receipt["localUnitGid"] = mask.stat().st_gid
            atomic_write(receipt_path.parent / "unit.before", mask.read_bytes())
        write_json(receipt_path, receipt)
    if not original_system_files_intact(receipt, allow_mask=True):
        fail("An original system-unit file changed. Its preserved copy will not overwrite newer edits.")
    if mask_is_expected(mask):
        systemctl("system", "daemon-reload")
    else:
        if not original_unit_visible(receipt, mask):
            fail("The original system unit is no longer selected. Review the changed configuration before retrying.")
        systemctl("system", "stop", args.unit)
        stopped = unit_properties("system", args.unit)
        if int(stopped.get("MainPID", "0")) or stopped.get("ActiveState") not in ("inactive", "failed"):
            fail("The old system service did not stop. No user service may be started.")
        receipt["phase"] = "stopped"
        write_json(receipt_path, receipt)
        if not original_system_files_intact(receipt):
            fail("The system unit changed while stopping. Its backup was preserved.")
        systemctl("system", "disable", args.unit)
        receipt["phase"] = "masking"
        write_json(receipt_path, receipt)
        temporary = mask.parent / ("." + args.unit + "." + uuid.uuid4().hex)
        try:
            os.symlink("/dev/null", temporary)
            os.replace(temporary, mask)
            sync_dir(mask.parent)
        finally:
            temporary.unlink(missing_ok=True)
        systemctl("system", "daemon-reload")
    stopped = unit_properties("system", args.unit)
    if int(stopped.get("MainPID", "0")) or stopped.get("ActiveState") not in ("inactive", "failed") or stopped.get("LoadState") != "masked":
        fail("The old system service is not safely masked and stopped. Do not start a user service.")
    if receipt["wasEnabled"] and not receipt["lingerWasEnabled"]:
        run([root_command("loginctl"), "enable-linger", account.pw_name])
    receipt["phase"] = "masked"
    write_json(receipt_path, receipt)
    return {"status": "system_released", "unit": args.unit, "owner": account.pw_name,
            "originalUnitPreserved": True, "receipt": str(receipt_path)}


def administrator_restore(args, account, receipt_path: Path, mask: Path) -> dict:
    receipt = read_json(receipt_path)
    if receipt.get("owner") != account.pw_name:
        fail("The administrative receipt belongs to a different account.")
    if args.start and not receipt["wasActive"]:
        fail("The original system service was stopped. Omit --start to preserve its state.")
    if receipt.get("phase") == "restored":
        if not original_unit_visible(receipt, mask):
            fail("The restored system unit changed after recovery.")
        return {"status": "system_restored", "unit": args.unit, "started": bool(args.start)}
    check = run_as_owner(account, [root_command("systemctl"), "--user", "show", args.unit, "-p", "MainPID", "-p", "ActiveState", "-p", "UnitFileState"])
    values = dict(line.split("=", 1) for line in check.stdout.splitlines() if "=" in line)
    if int(values.get("MainPID", "0")) or values.get("ActiveState") in ("active", "activating", "deactivating") or values.get("UnitFileState") in ("enabled", "enabled-runtime"):
        fail("Stop and disable the user service before restoring the system service. Both must never run together.")
    # Candidate code validates data only after privilege is dropped. No downloaded
    # application or migration module is imported by the administrator process.
    validation = (
        "import importlib.util,sys;from pathlib import Path;"
        "s=importlib.util.spec_from_file_location('guard',sys.argv[1]);"
        "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);"
        "a=m.read_activation(Path(sys.argv[3]));"
        "assert not a or (a.get('status')!='pending' and a.get('candidatePath')!=sys.argv[4]),'Pending or accepted candidate needs data recovery';"
        "m.can_start_release(Path(sys.argv[2]),Path(sys.argv[3]))"
    )
    run_as_owner(account, [root_command("python3"), "-c", validation,
                          str(Path(receipt["candidate"]) / "scripts/guarded-release.py"),
                          receipt["baseline"], receipt["dataDir"], receipt["candidate"]])
    if not original_system_files_intact(receipt, allow_mask=True):
        fail("An original system-unit file changed. Review it before restoring the service.")
    if not mask_is_expected(mask) and not original_unit_visible(receipt, mask):
        fail("The system unit mask changed. Preserve its current configuration before recovery.")
    receipt["phase"] = "restoring"
    write_json(receipt_path, receipt)
    if mask_is_expected(mask):
        if receipt.get("localUnit"):
            content = (receipt_path.parent / "unit.before").read_bytes()
            expected = next(item["sha256"] for item in receipt["files"] if item["path"] == str(mask))
            if digest(content) != expected:
                fail("The preserved original system unit failed verification.")
            temporary = mask.parent / ("." + args.unit + ".restore." + uuid.uuid4().hex)
            try:
                atomic_write(temporary, content, receipt["localUnitMode"])
                os.chown(temporary, receipt["localUnitUid"], receipt["localUnitGid"])
                os.replace(temporary, mask)
                sync_dir(mask.parent)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            mask.unlink()
            sync_dir(mask.parent)
    systemctl("system", "daemon-reload")
    systemctl("system", "enable" if receipt["wasEnabled"] else "disable", args.unit)
    if not receipt["lingerWasEnabled"] and receipt["wasEnabled"]:
        run([root_command("loginctl"), "disable-linger", account.pw_name])
    if args.start:
        systemctl("system", "start", args.unit)
    receipt["phase"] = "restored"
    write_json(receipt_path, receipt)
    return {"status": "system_restored", "unit": args.unit, "started": bool(args.start)}


def admin_action(args) -> dict:
    if os.geteuid() != ROOT_UID:
        fail("This narrow system-service action requires an administrator. The normal upgrader must run as the service user.")
    account = pwd.getpwnam(args.owner)
    if account.pw_uid == 0:
        fail("Root-run bot installations require an explicit ownership migration.")
    receipt_path = admin_receipt(args.unit)
    private_directory(ADMIN_DIR)
    private_directory(receipt_path.parent)
    with (receipt_path.parent / "action.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "system-release":
            return administrator_release(args, account, receipt_path, SYSTEM_DIR / args.unit)
        return administrator_restore(args, account, receipt_path, SYSTEM_DIR / args.unit)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Plan and apply a versioned BlackDogBot upgrade.")
    result.add_argument("action", choices=["plan", "apply", "recover", "system-release", "system-restore"])
    result.add_argument("--repo", type=Path)
    result.add_argument("--revision", help="Version tag or full commit SHA; default: latest published stable release")
    result.add_argument("--previous-revision", help="Reviewed full SHA of an unchanged direct-service checkout")
    result.add_argument("--scope", choices=["auto", "user", "system"], default="auto")
    result.add_argument("--unit")
    result.add_argument("--data-dir", type=Path)
    result.add_argument("--state", type=Path)
    result.add_argument("--runtime-cwd", type=Path)
    result.add_argument("--database-source", type=Path)
    result.add_argument("--import-legacy-tasks", action="store_true")
    result.add_argument("--timeout", type=int, default=180)
    result.add_argument("--owner", help="Service account for the narrow administrator action")
    result.add_argument("--fingerprint")
    result.add_argument("--candidate", type=Path)
    result.add_argument("--baseline", type=Path)
    result.add_argument("--start", action="store_true", help="Restore the previously running system service")
    return result


def select_saved_operation(args, account) -> dict | None:
    if args.state:
        return load_operation(absolute(args.state, "--state"))
    roots = [absolute(args.data_dir, "--data-dir")] if args.data_dir else [Path(account.pw_dir) / ".blackdogbot", Path(account.pw_dir) / ".betterclaw"]
    found = []
    for root in roots:
        saved = load_operation(root / "deploy")
        if saved and (saved["phase"] not in TERMINAL or args.action == "recover"):
            found.append(saved)
    if len(found) > 1:
        fail("More than one saved upgrade needs attention. Supply --state from the relevant upgrade report.")
    return found[0] if found else None


def validate_resume_options(args, operation: dict) -> None:
    service = operation["service"]
    comparisons = ((args.repo, operation["repo"], "--repo"), (args.data_dir, operation["dataDir"], "--data-dir"),
                   (args.runtime_cwd, service["runtimeCwd"], "--runtime-cwd"))
    for supplied, expected, label in comparisons:
        if supplied and str(absolute(supplied, label)) != expected:
            fail(label + " differs from the saved upgrade. Recover it before selecting another installation.")
    if args.unit and args.unit != service["unit"] or args.scope != "auto" and args.scope != service["scope"]:
        fail("The selected service differs from the saved upgrade.")
    if args.revision and args.revision not in (operation["reference"], operation["revision"]):
        fail("A different upgrade is unfinished. Recover it before selecting another release.")
    source = str(absolute(args.database_source, "--database-source")) if args.database_source else operation.get("databaseSource")
    if source != operation.get("databaseSource") or args.import_legacy_tasks and not operation.get("importLegacyTasks"):
        report = latest_guard_report(Path(operation["state"]))
        before_data_changes = operation["phase"] in ("planned", "candidate_prepared", "administrator_required", "launcher_prepared") or (
            report.get("status") == "preflight_failed" and report.get("revision") == operation["revision"] and report.get("data_unchanged") is True)
        if not before_data_changes:
            fail("Migration options can only change before migration starts. Finish recovery before changing the database source.")
        operation["databaseSource"] = source
        operation["importLegacyTasks"] = args.import_legacy_tasks or operation.get("importLegacyTasks", False)


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["--"]:
        arguments = arguments[1:]
    args = parser().parse_args(arguments)
    if sys.version_info < (3, 9):
        fail("Python 3.9 or newer is required.")
    if args.timeout < 5 or args.timeout > 3600:
        fail("--timeout must be between 5 and 3600 seconds.")
    if args.action.startswith("system-"):
        if not args.owner or not args.unit:
            fail("The administrative action requires --owner and --unit.")
        if args.action == "system-release" and not all([args.fingerprint, args.candidate, args.baseline, args.data_dir]):
            fail("Use the complete administrator command from the reviewed upgrade plan.")
        print(json.dumps(admin_action(args), indent=2))
        return 0
    if os.geteuid() == 0:
        fail("Run plan/apply/recover as the account that owns the bot. Only the narrow system-service actions run as root.")
    if any([args.owner, args.fingerprint, args.candidate, args.baseline, args.start]):
        fail("Administrator options are only valid for system-release/system-restore.")
    account = pwd.getpwuid(os.geteuid())
    pending = select_saved_operation(args, account)
    if pending and (pending["phase"] not in TERMINAL or args.action == "recover"):
        validate_resume_options(args, pending)
        operation = pending
    elif args.action == "recover":
        fail("No saved upgrade was selected. Supply --state from its saved report.")
    else:
        operation = build_plan(args, account)
    if args.action == "plan":
        print(json.dumps(public_operation(operation), indent=2))
        return 0
    state = Path(operation["state"])
    private_directory(state)
    with (state / "upgrade.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        operation = recover_operation(operation, account) if args.action == "recover" else apply_operation(operation, account)
    print(json.dumps(public_operation(operation), indent=2))
    return 0 if operation["phase"] in ("healthy", "restored") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except UpgradeError as error:
        print(json.dumps({"protocolVersion": 1, "status": "blocked", "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"protocolVersion": 1, "status": "failed",
                          "error": "Upgrade operation failed (" + type(error).__name__ + "). Preserve its journal and inspect before restarting."}), file=sys.stderr)
        raise SystemExit(1)
