# Releases

A release identifies one tested Git commit. The package version, Git tag, release
notes, installer pin, and release manifest must agree.

## Install a published version

For a fresh installation, download the released installer and inspect it:

~~~sh
curl -fsSLo /tmp/blackdogbot-install.sh https://github.com/mistrjirka/BlackDogBot/releases/latest/download/blackdogbot-install.sh
less /tmp/blackdogbot-install.sh
sh /tmp/blackdogbot-install.sh
~~~

The latest download URL selects the latest published stable release. The
downloaded script pins that release's full commit ID. It clones a Git checkout
and runs the interactive installer as your ordinary user. It requires a terminal
and refuses existing configuration or source destinations.

To select one version, replace `latest/download` with `download/v0.2.0`.
An explicit `BLACKDOGBOT_REF` overrides the installer pin. Use that override
only when you intend to run a different reviewed tag, branch, or full commit.

GitHub's automatic source ZIP/tar archives are review sources. Use the released
installer or a Git clone for a managed installation, which needs Git history
to prepare releases.

## Upgrade an existing installation

Download the standalone script from the same release:

~~~sh
curl -fsSLo /tmp/blackdogbot-upgrade.py https://github.com/mistrjirka/BlackDogBot/releases/latest/download/blackdogbot-upgrade.py
python3 /tmp/blackdogbot-upgrade.py plan --repo /absolute/path/to/BlackDogBot
python3 /tmp/blackdogbot-upgrade.py apply --repo /absolute/path/to/BlackDogBot
~~~

The script uses Python's standard library. It can run before the old checkout has
the new package command. It resolves the latest stable tag to an exact commit,
then uses the candidate's migration and validation tools. Pass
`--revision v0.2.0` to choose one version explicitly.

See [upgrading](upgrade.md) for supported service layouts, administrator
handoff, and recovery. Never rerun the fresh installer over an existing data root.

## Assets and checksums

| Asset | Purpose |
| --- | --- |
| `blackdogbot-install.sh` | Fresh interactive installation pinned to the release commit. |
| `blackdogbot-upgrade.py` | Standalone upgrade planner, runner, and recovery entry point. |
| `release-manifest.json` | Tag, version, commit, requirements, schema version, script sizes and hashes. |
| `SHA256SUMS` | Checksums for the two scripts and release manifest. |

Download all four files into an empty directory and run
`sha256sum -c SHA256SUMS` there. Checksums detect altered or incomplete downloads.
Their source of trust is the same GitHub release as the scripts.

## Maintainer procedure

1. Update `package.json` and add the exact `## vX.Y.Z` heading in `CHANGELOG.md`.
2. Merge the changes into `main`.
3. Check that the main CI run succeeded.
4. Create an annotated version tag on that commit.
5. Push the tag.

~~~sh
git tag -a v0.2.0 -m "BlackDogBot v0.2.0"
git push origin v0.2.0
~~~

The release workflow calls the same CI workflow on the tagged commit. It checks
shell syntax, TypeScript, isolated tests, Python upgrade/recovery tests, and the
build on Node 22, 24, and 26.

Only the publication job has write permission. After validation, it checks the
tag against the package version, confirms that the commit belongs to `main`,
and creates deterministic assets. It creates a draft release first, uploads the
files, and verifies GitHub's reported size and SHA-256 digest for every asset
before publishing.

A failed upload leaves a draft. Rerun the failed workflow or dispatch the release
workflow with the same tag. Matching assets are reused. Changed metadata,
unexpected assets, and incorrect checksums stop publication. Published artifacts
are not silently replaced and tags are not moved.

Release preparation can be inspected locally without publication:

~~~sh
python3 scripts/release.py prepare --tag v0.2.0 --output /absolute/new/output-directory
~~~

The output directory must not exist. The tracked checkout must be clean and
checked out at the requested tag.
