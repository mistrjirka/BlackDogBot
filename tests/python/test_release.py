import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("blackdog_release", ROOT / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class FakeGitHub:
    repository = "mistrjirka/BlackDogBot"
    base = "https://api.github.com/repos/" + repository

    def __init__(self):
        self.release = None
        self.saved = []
        self.calls = []
        self.bad_digest = False
        self.fail_upload = None
        self.tag_checks = 0
        self.move_tag_after_upload = False

    def verify_tag(self, tag, commit):
        self.tag_checks += 1
        if self.move_tag_after_upload and self.tag_checks > 1:
            raise release.ReleaseError("The remote tag moved after validation.")

    def find_release(self, tag):
        return None if self.release is None else dict(self.release)

    def assets(self, release_id):
        return [dict(asset) for asset in self.saved]

    def request(self, method, url, payload=None, binary=False):
        self.calls.append((method, url))
        if method == "POST" and url == self.base + "/releases":
            self.release = dict(payload, id=7,
                upload_url="https://uploads.github.com/repos/" + self.repository + "/releases/7/assets{?name,label}",
                html_url="https://github.com/" + self.repository + "/releases/tag/" + payload["tag_name"])
            return dict(self.release)
        if method == "POST" and "uploads.github.com" in url:
            name = url.split("?name=")[1]
            if self.fail_upload == name:
                raise release.ReleaseError("Simulated upload interruption")
            asset = {"name": name, "state": "uploaded", "size": len(payload),
                     "digest": "sha256:" + hashlib.sha256(payload).hexdigest()}
            if self.bad_digest:
                asset["digest"] = "sha256:" + "0" * 64
            self.saved.append(asset)
            return dict(asset)
        if method == "PATCH":
            self.release.update(payload)
            return dict(self.release)
        raise AssertionError((method, url))


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="blackdog-release-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Release Test")
        (self.repo / "scripts").mkdir()
        (self.repo / "scripts/bootstrap.sh").write_text("#!/bin/sh\nset -eu\nREF=main\n")
        (self.repo / "scripts/upgrade.py").write_text("#!/usr/bin/env python3\nprint('fixture')\n")
        (self.repo / "package.json").write_text(json.dumps({
            "version": "0.2.0", "engines": {"node": ">=22.13.0"}, "packageManager": "pnpm@11.28.3"}))
        (self.repo / "CHANGELOG.md").write_text("# Changelog\n\n## v0.2.0\n\nTested release.\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.git("tag", "-a", "v0.2.0", "-m", "fixture")
        self.commit = self.git("rev-parse", "HEAD")
        self.output = self.root / "output"

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        result = subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                                capture_output=True, text=True, timeout=20)
        return result.stdout.strip()

    def prepare(self):
        return release.prepare(self.repo, "v0.2.0", self.output)

    def test_assets_pin_exact_commit_and_checksums_are_reproducible(self):
        prepared = self.prepare()
        self.assertEqual(prepared["commit"], self.commit)
        self.assertIn("BLACKDOGBOT_REF:=" + self.commit, (self.output / "blackdogbot-install.sh").read_text())
        manifest = json.loads((self.output / "release-manifest.json").read_text())
        self.assertEqual(manifest["version"], "0.2.0")
        self.assertEqual(manifest["commit"], self.commit)
        self.assertEqual(manifest["dataSchemaVersion"], 2)
        for line in (self.output / "SHA256SUMS").read_text().splitlines():
            expected, name = line.split("  ")
            self.assertEqual(expected, hashlib.sha256((self.output / name).read_bytes()).hexdigest())
        second = self.root / "second"
        release.prepare(self.repo, "v0.2.0", second)
        for name in release.ASSET_NAMES:
            self.assertEqual((self.output / name).read_bytes(), (second / name).read_bytes())

    def test_refuses_version_mismatch(self):
        self.git("tag", "v0.3.0")
        with self.assertRaisesRegex(release.ReleaseError, "version differ"):
            release.prepare(self.repo, "v0.3.0", self.output)
        self.assertFalse(self.output.exists())

    def test_refuses_changed_source_and_wrong_tag(self):
        (self.repo / "scripts/upgrade.py").write_text("changed\n")
        with self.assertRaisesRegex(release.ReleaseError, "committed"):
            self.prepare()
        self.git("add", ".")
        self.git("commit", "-qm", "newer source")
        with self.assertRaisesRegex(release.ReleaseError, "checked-out commit"):
            self.prepare()

    def test_refuses_missing_notes_and_stale_output(self):
        (self.repo / "CHANGELOG.md").write_text("# Changelog\n")
        self.git("add", ".")
        self.git("commit", "-qm", "missing notes")
        self.git("tag", "-f", "v0.2.0")
        with self.assertRaisesRegex(release.ReleaseError, "exact section"):
            self.prepare()
        (self.repo / "CHANGELOG.md").write_text("# Changelog\n\n## v0.2.0\n\nNotes\n")
        self.git("add", ".")
        self.git("commit", "-qm", "notes")
        self.git("tag", "-f", "v0.2.0")
        self.output.mkdir()
        (self.output / "unexpected").write_text("keep")
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual((self.output / "unexpected").read_text(), "keep")

    def test_draft_is_published_only_after_all_assets_verify_and_retry_is_read_only(self):
        self.prepare()
        client = FakeGitHub()
        result = release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertEqual(result["status"], "published")
        self.assertFalse(client.release["draft"])
        self.assertEqual(client.calls[-1][0], "PATCH")
        count = len(client.calls)
        release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertEqual(len(client.calls), count)

    def test_interrupted_upload_remains_draft_and_resumes_without_duplicates(self):
        self.prepare()
        client = FakeGitHub()
        client.fail_upload = "release-manifest.json"
        with self.assertRaisesRegex(release.ReleaseError, "interruption"):
            release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertTrue(client.release["draft"])
        self.assertEqual(len(client.saved), 2)
        client.fail_upload = None
        release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertFalse(client.release["draft"])
        self.assertEqual(len(client.saved), 4)

    def test_tag_move_during_upload_leaves_draft(self):
        self.prepare()
        client = FakeGitHub()
        client.move_tag_after_upload = True
        with self.assertRaisesRegex(release.ReleaseError, "tag moved"):
            release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertTrue(client.release["draft"])
        self.assertFalse(any(method == "PATCH" for method, _ in client.calls))

    def test_corrupt_asset_never_publishes(self):
        self.prepare()
        client = FakeGitHub()
        client.bad_digest = True
        with self.assertRaisesRegex(release.ReleaseError, "incomplete"):
            release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertTrue(client.release["draft"])
        self.assertFalse(any(method == "PATCH" for method, _ in client.calls))

    def test_published_release_drift_never_overwrites_assets(self):
        self.prepare()
        client = FakeGitHub()
        release.publish(client, "v0.2.0", self.commit, self.output)
        count = len(client.calls)
        client.saved[0]["digest"] = "sha256:" + "a" * 64
        with self.assertRaisesRegex(release.ReleaseError, "incomplete"):
            release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertEqual(len(client.calls), count)
        client.saved.pop()
        with self.assertRaisesRegex(release.ReleaseError, "published release is incomplete"):
            release.publish(client, "v0.2.0", self.commit, self.output)

    def test_changed_metadata_never_changes_existing_release(self):
        self.prepare()
        client = FakeGitHub()
        release.publish(client, "v0.2.0", self.commit, self.output)
        client.release["target_commitish"] = "b" * 40
        count = len(client.calls)
        with self.assertRaisesRegex(release.ReleaseError, "different metadata"):
            release.publish(client, "v0.2.0", self.commit, self.output)
        self.assertEqual(len(client.calls), count)

    def test_upload_endpoint_does_not_send_credentials_to_another_host(self):
        client = release.GitHub("test-token")
        with self.assertRaisesRegex(release.ReleaseError, "Untrusted"):
            client.request("POST", "https://example.invalid/assets", b"content", binary=True)


if __name__ == "__main__":
    unittest.main()
