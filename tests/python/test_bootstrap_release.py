from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def function_source(name):
    text = (ROOT / "scripts/bootstrap.sh").read_text()
    start = text.index(name + "() {")
    end = text.index("\n}", start) + 2
    return text[start:end]


class BootstrapCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="blackdog-bootstrap-")
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Bootstrap Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.source / "content").write_text("tagged bytes")
        self.git("add", ".")
        self.git("commit", "-qm", "tagged version")
        self.sha = self.git("rev-parse", "HEAD")
        self.git("tag", "-a", "v0.2.0", "-m", "test release")
        (self.source / "content").write_text("newer main bytes")
        self.git("commit", "-qam", "new main")
        self.main = self.git("rev-parse", "HEAD")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.source), *args], check=True,
                              capture_output=True, text=True, timeout=20).stdout.strip()

    def checkout(self, ref):
        destination = self.root / "destination"
        script = "set -eu\n" + function_source("checkout_source") + '\ncheckout_source "$1" "$2" "$3"\n'
        result = subprocess.run(["sh", "-c", script, "_", self.source.as_uri(), ref, str(destination)],
                                capture_output=True, text=True, timeout=20)
        return result, destination

    def test_annotated_release_tag_selects_older_release_not_main(self):
        result, target = self.checkout("v0.2.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((target / "content").read_text(), "tagged bytes")

    def test_full_commit_fetch_supports_exact_pinned_installation(self):
        result, target = self.checkout(self.sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = subprocess.run(["git", "-C", str(target), "rev-parse", "HEAD"],
                                check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(actual, self.sha)
        self.assertEqual((target / "content").read_text(), "tagged bytes")

    def test_explicit_development_branch_remains_supported(self):
        result, target = self.checkout("main")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((target / "content").read_text(), "newer main bytes")

    def test_nonexistent_commit_never_falls_back_to_main(self):
        result, target = self.checkout("1" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((target / "content").exists())

    def test_untrusted_ref_is_not_executed(self):
        marker = self.root / "unexpected"
        result, target = self.checkout("$(touch " + str(marker) + ")")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
