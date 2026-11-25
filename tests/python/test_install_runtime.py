"""Installer runtime failures must stop before writing application configuration."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def functions(*names):
    source = (ROOT / "install.sh").read_text()
    result = []
    for name in names:
        start = source.index(name + "() {")
        end = source.index("\n}", start) + 2
        result.append(source[start:end])
    return "\n".join(result)


class InstallerRuntimeTests(unittest.TestCase):
    def test_installs_exact_declared_package_manager_when_existing_version_differs(self):
        declared = json.loads((ROOT / "package.json").read_text())["packageManager"]
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "installed"
            arguments = Path(folder) / "npm-arguments"
            script = functions("check_dependencies")
            script += r"""
fixture_repo="$1"
fixture_marker="$2"
fixture_arguments="$3"
fixture_spec="$4"
get_script_dir() { printf '%s\n' "$fixture_repo"; }
print_error() { printf '%s\n' "$*" >&2; }
print_info() { :; }
print_success() { :; }
print_warning() { :; }
pnpm() {
    if [ -f "$fixture_marker" ]; then
        printf '%s\n' "${fixture_spec#pnpm@}"
    else
        printf '1.0.0\n'
    fi
}
npm() {
    printf '%s\n' "$@" > "$fixture_arguments"
    touch "$fixture_marker"
}
docker() { return 1; }
check_dependencies
"""
            result = subprocess.run(
                ["bash", "-c", script, "_", str(ROOT), str(marker), str(arguments), declared],
                capture_output=True, text=True, timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            argv = arguments.read_text().splitlines()
            self.assertEqual(argv[:3], ["install", "--global", "--prefix"])
            self.assertEqual(argv[-1], declared)
            self.assertNotIn("pnpm@latest", argv)
            self.assertEqual(argv[3], str(Path.home() / ".local"))

    def test_missing_python_stops_before_package_manager_changes(self):
        script = functions("check_dependencies")
        script += r"""
print_error() { printf '%s\n' "$*" >&2; }
print_success() { :; }
command() {
    if [ "$1" = "-v" ] && [ "$2" = "python3" ]; then
        return 1
    fi
    builtin command "$@"
}
pnpm() { printf 'UNSAFE_PACKAGE_MANAGER_CHANGE\n'; }
npm() { printf 'UNSAFE_PACKAGE_MANAGER_CHANGE\n'; }
check_dependencies
printf 'UNSAFE_CONTINUE\n'
"""
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.9 or newer is required", result.stderr)
        self.assertNotIn("UNSAFE_", result.stdout)

    def test_unusable_sqlite_stops_installation_after_one_rebuild(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = Path(folder) / "pnpm-calls"
            script = functions("verify_native_sqlite", "install_dependencies")
            script += r"""
fixture_repo="$1"
fixture_calls="$2"
get_script_dir() { printf '%s\n' "$fixture_repo"; }
print_error() { printf '%s\n' "$*" >&2; }
print_success() { :; }
print_warning() { :; }
node() { return 1; }
pnpm() { printf '%s\n' "$*" >> "$fixture_calls"; }
install_dependencies
printf 'UNSAFE_CONTINUE\n'
"""
            result = subprocess.run(
                ["bash", "-c", script, "_", folder, str(calls)],
                capture_output=True, text=True, timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("UNSAFE_CONTINUE", result.stdout)
            self.assertIn("still unusable", result.stderr)
            self.assertEqual(calls.read_text().splitlines(), [
                "install --frozen-lockfile", "rebuild better-sqlite3",
            ])


if __name__ == "__main__":
    unittest.main()
