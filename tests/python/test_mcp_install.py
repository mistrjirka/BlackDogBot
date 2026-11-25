"""Offline checks for the three MCP entries produced by the install wizard."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def bash(source, *, home, input_text=""):
    return subprocess.run(
        ["bash", "-c", 'source <(head -n -1 install.sh)\n' + source],
        cwd=ROOT, env={**os.environ, "HOME": str(home)},
        input=input_text, capture_output=True, text=True, timeout=20,
    )


class McpInstallerTests(unittest.TestCase):
    def test_registers_three_mcp_servers_with_local_binaries(self):
        with tempfile.TemporaryDirectory() as dirname:
            home = Path(dirname)
            commands = r'''
set -eo pipefail
umask 077
mkdir -p "$CONFIG_DIR"
SEARXNG_URL="http://127.0.0.1:18731"
SCRAPLING_URL="http://127.0.0.1:18733/mcp"
SETUP_SEARXNG=true; SETUP_SCRAPLING=true; START_SERVICES=false
MCP_ROOT="$HOME/.local/share/blackdogbot/mcp"
SEARXNG_MCP_BIN="$MCP_ROOT/searxng/node_modules/.bin/mcp-searxng"
PLAYWRIGHT_MCP_BIN="$MCP_ROOT/playwright/node_modules/.bin/playwright-mcp"
create_docker_compose >/dev/null
{ printf "2\n"; for i in {1..19}; do printf "\n"; done; } | create_config >/dev/null
register_playwright_mcp >/dev/null
'''
            proc = bash(commands, home=home)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            folder = home / ".blackdogbot"
            servers = json.loads((folder / "mcp-servers.json").read_text())["mcpServers"]
            self.assertEqual(sorted(servers), ["playwright", "scrapling", "searxng"])
            self.assertEqual(servers["searxng"]["args"], [])
            self.assertTrue(servers["searxng"]["command"].endswith("/.bin/mcp-searxng"))
            self.assertTrue(servers["playwright"]["command"].endswith("/.bin/playwright-mcp"))
            self.assertTrue(servers["playwright"]["env"]["PLAYWRIGHT_BROWSERS_PATH"].endswith("/playwright/browsers"))
            self.assertEqual(servers["playwright"]["args"][:2], ["--browser", "firefox"])
            self.assertEqual(servers["scrapling"]["transport"], "http")
            self.assertTrue(servers["scrapling"]["headers"]["Authorization"].startswith("Bearer "))
            self.assertEqual((folder / "mcp-servers.json").stat().st_mode & 0o777, 0o600)
            compose = (folder / "docker-compose.yaml").read_text()
            self.assertIn("searxng/searxng@sha256:c750ee1d", compose)
            self.assertIn("pyd4vinci/scrapling@sha256:b4e92cde", compose)

    def test_no_docker_still_asks_for_remote_services(self):
        with tempfile.TemporaryDirectory() as dirname:
            proc = bash('''HAS_DOCKER=false
setup_docker_services
printf "\\nRESULT %s %s %s\\n" "$SEARXNG_URL" "$SCRAPLING_URL" "$SETUP_SCRAPLING"
''', home=Path(dirname), input_text="https://search.example\nhttps://scrape.example/mcp\nexample-test-token\n")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("RESULT https://search.example https://scrape.example/mcp false", proc.stdout)

    def test_runtimes_and_browser_versions_are_pinned(self):
        script = (ROOT / "scripts/install-mcp-runtime.sh").read_text()
        self.assertIn("mcp-searxng@2.10.0", script)
        self.assertIn("@playwright/mcp@0.0.84", script)
        self.assertIn('PLAYWRIGHT_BROWSERS_PATH="$destination/browsers"', script)
        self.assertNotIn("playwright@latest", script)


if __name__ == "__main__":
    unittest.main()
