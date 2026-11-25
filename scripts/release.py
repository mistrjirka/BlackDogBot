#!/usr/bin/env python3
"""Build deterministic release assets and publish only after every asset verifies.

The GitHub workflow validates the tagged commit before calling this script.
Publication starts as a draft. Retries accept matching assets and refuse drift.
No access token or API response body is printed on errors.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
REPOSITORY = "mistrjirka/BlackDogBot"
VERSION = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")
ASSET_NAMES = ("blackdogbot-install.sh", "blackdogbot-upgrade.py",
               "release-manifest.json", "SHA256SUMS")


class ReleaseError(RuntimeError):
    pass


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], text=True,
                            capture_output=True, timeout=60)
    if result.returncode:
        raise ReleaseError("Git validation failed: " + args[0])
    return result.stdout.strip()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def release_notes(repo, tag):
    changelog = (repo / "CHANGELOG.md").read_text(encoding="utf-8")
    heading = "## " + tag + "\n"
    if heading not in changelog:
        raise ReleaseError("CHANGELOG.md has no exact section for " + tag)
    body = changelog.split(heading, 1)[1].split("\n## ", 1)[0].strip()
    if not body:
        raise ReleaseError("The release notes are empty.")
    return body


def prepare(repo, tag, output):
    repo, output = Path(repo).resolve(), Path(output).resolve()
    if not VERSION.fullmatch(tag):
        raise ReleaseError("Use a stable version tag such as v0.2.0.")
    package = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    if package.get("version") != tag[1:]:
        raise ReleaseError("The tag and package.json version differ.")
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise ReleaseError("Tracked source changes must be committed before release.")
    head = git(repo, "rev-parse", "HEAD")
    if git(repo, "rev-parse", "--verify", "refs/tags/" + tag + "^{commit}") != head:
        raise ReleaseError("The tag does not identify the checked-out commit.")
    notes = release_notes(repo, tag)
    bootstrap = (repo / "scripts/bootstrap.sh").read_text(encoding="utf-8")
    if bootstrap.count("set -eu\n") != 1:
        raise ReleaseError("Cannot pin this bootstrap script.")
    pinned = bootstrap.replace("set -eu\n", "set -eu\n"
        + "# Release " + tag + " at " + head + "\n"
        + ': "${BLACKDOGBOT_REF:=' + head + '}"\n', 1)
    files = {
        "blackdogbot-install.sh": pinned.encode(),
        "blackdogbot-upgrade.py": (repo / "scripts/upgrade.py").read_bytes(),
    }
    manifest = {
        "formatVersion": 1, "version": package["version"], "tag": tag,
        "commit": head, "repository": "https://github.com/" + REPOSITORY,
        "requirements": {"platform": "Linux", "node": package["engines"]["node"],
                         "python": ">=3.9", "packageManager": package["packageManager"]},
        "dataSchemaVersion": 2,
        "assets": {name: {"sha256": digest(data), "size": len(data)}
                   for name, data in sorted(files.items())},
    }
    files["release-manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    files["SHA256SUMS"] = "".join(digest(data) + "  " + name + "\n"
                                for name, data in sorted(files.items())).encode()
    # A new output directory prevents stale artifacts leaking into a release.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for name, data in files.items():
        target = output / name
        target.write_bytes(data)
        target.chmod(0o755 if name.endswith((".sh", ".py")) else 0o644)
    notes += "\n\nCommit: https://github.com/" + REPOSITORY + "/commit/" + head
    notes += "\n\nInstallation and upgrade instructions: https://github.com/" + REPOSITORY + "/blob/" + tag + "/docs/releases.md\n"
    (output / "release-notes.md").write_text(notes, encoding="utf-8")
    return {"tag": tag, "commit": head, "output": str(output), "assets": list(ASSET_NAMES)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ReleaseError("Unexpected API redirect. Publication stopped.")


class GitHub:
    def __init__(self, token, repository=REPOSITORY):
        if not token:
            raise ReleaseError("GITHUB_TOKEN is required to publish.")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ReleaseError("Invalid GitHub repository.")
        self.token = token
        self.repository = repository
        self.base = API + "/repos/" + repository
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, url, payload=None, binary=False, allow_missing=False):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc not in ("api.github.com", "uploads.github.com"):
            raise ReleaseError("Untrusted release API endpoint.")
        if parsed.username or parsed.password or parsed.fragment:
            raise ReleaseError("Invalid release API endpoint.")
        headers = {"Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2026-03-10",
                   "User-Agent": "BlackDogBot-release",
                   "Authorization": "Bearer " + self.token}
        data = payload
        if payload is not None:
            if not binary:
                data = json.dumps(payload).encode()
            headers["Content-Type"] = "application/octet-stream" if binary else "application/json"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=90) as response:
                raw = response.read(16 * 1024 * 1024)
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if allow_missing and error.code == 404:
                return None
            raise ReleaseError("GitHub " + method + " failed with HTTP " + str(error.code)) from None
        except (OSError, ValueError):
            raise ReleaseError("GitHub request failed. Retry the same tag after checking connectivity.") from None

    def find_release(self, tag):
        # Drafts are not consistently returned by the public tag endpoint.
        for page in range(1, 101):
            values = self.request("GET", self.base + "/releases?per_page=100&page=" + str(page))
            if not isinstance(values, list):
                raise ReleaseError("Unexpected release list.")
            matches = [value for value in values if value.get("tag_name") == tag]
            if len(matches) > 1:
                raise ReleaseError("Duplicate release identity.")
            if matches:
                return matches[0]
            if len(values) < 100:
                return None
        raise ReleaseError("Release history exceeds the supported lookup limit.")

    def verify_tag(self, tag, commit):
        value = self.request("GET", self.base + "/git/ref/tags/" + urllib.parse.quote(tag, safe=""))
        target = value.get("object", {})
        for _ in range(10):
            if target.get("type") == "commit":
                if target.get("sha") != commit:
                    raise ReleaseError("The remote tag moved after validation. Publication stopped.")
                return
            if target.get("type") != "tag" or not re.fullmatch(r"[0-9a-f]{40}", target.get("sha", "")):
                break
            value = self.request("GET", self.base + "/git/tags/" + target["sha"])
            target = value.get("object", {})
        raise ReleaseError("The remote tag cannot be resolved to the validated commit.")

    def assets(self, release_id):
        values = self.request("GET", self.base + "/releases/" + str(release_id) + "/assets?per_page=100")
        if not isinstance(values, list) or len(values) >= 100:
            raise ReleaseError("Unexpected release asset list.")
        return values


def validate_asset(asset, name, content):
    if (asset.get("name") != name or asset.get("state") != "uploaded"
            or asset.get("size") != len(content)
            or asset.get("digest") != "sha256:" + digest(content)):
        raise ReleaseError("Release asset differs or is incomplete: " + name
                           + ". Preserve it and resolve the draft before retrying.")


def publish(client, tag, commit, output):
    output = Path(output)
    notes = (output / "release-notes.md").read_text(encoding="utf-8")
    local = {name: (output / name).read_bytes() for name in ASSET_NAMES}
    client.verify_tag(tag, commit)
    release = client.find_release(tag)
    if release is None:
        release = client.request("POST", client.base + "/releases", {
            "tag_name": tag, "target_commitish": commit,
            "name": "BlackDogBot " + tag, "body": notes,
            "draft": True, "prerelease": False,
        })
    if (release.get("tag_name") != tag or release.get("prerelease")
            or release.get("target_commitish") != commit or release.get("body") != notes):
        raise ReleaseError("An existing release has different metadata. Publication stopped.")
    release_id = release.get("id")
    if type(release_id) is not int:
        raise ReleaseError("Invalid release ID.")
    existing = client.assets(release_id)
    by_name = {value.get("name"): value for value in existing}
    if len(by_name) != len(existing) or set(by_name) - set(local):
        raise ReleaseError("The release has duplicate or unexpected assets.")
    if not release.get("draft") and set(by_name) != set(local):
        raise ReleaseError("A published release is incomplete. It will not be modified automatically.")
    upload_url = release.get("upload_url", "").split("{", 1)[0]
    expected_upload = "https://uploads.github.com/repos/" + client.repository + "/releases/" + str(release_id) + "/assets"
    if upload_url != expected_upload:
        raise ReleaseError("Unexpected asset upload endpoint.")
    for name, content in local.items():
        if name in by_name:
            validate_asset(by_name[name], name, content)
        else:
            asset = client.request("POST", upload_url + "?name=" + urllib.parse.quote(name),
                                   content, binary=True)
            validate_asset(asset, name, content)
    # Re-read server state before making anything public.
    final_assets = client.assets(release_id)
    if len(final_assets) != len(local) or {a.get("name") for a in final_assets} != set(local):
        raise ReleaseError("The uploaded asset inventory is incomplete.")
    for asset in final_assets:
        validate_asset(asset, asset["name"], local[asset["name"]])
    client.verify_tag(tag, commit)
    if release.get("draft"):
        release = client.request("PATCH", client.base + "/releases/" + str(release_id),
                                 {"draft": False, "make_latest": "true"})
        if release.get("draft") or release.get("tag_name") != tag:
            raise ReleaseError("GitHub did not confirm publication.")
    return {"status": "published", "tag": tag, "commit": commit, "url": release.get("html_url")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "publish"))
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.action == "publish":
        repository = os.environ.get("GITHUB_REPOSITORY", REPOSITORY)
        if repository != REPOSITORY:
            raise ReleaseError("Publication is restricted to " + REPOSITORY + ".")
        repo = Path(args.repo).resolve()
        # A tag must point to code already merged into main.
        git(repo, "merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main")
    prepared = prepare(args.repo, args.tag, args.output)
    if args.action == "publish":
        prepared = publish(GitHub(os.environ.get("GITHUB_TOKEN", "")), args.tag,
                           prepared["commit"], args.output)
    print(json.dumps(prepared, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, ValueError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
