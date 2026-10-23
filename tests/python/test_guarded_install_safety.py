from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "install.sh"


def function_source(*names):
    text = SOURCE.read_text()
    blocks = []
    for name in names:
        first = text.index(name + "() {")
        end = text.index("\n}", first) + 2
        blocks.append(text[first:end])
    return "\n\n".join(blocks)


class InstallerSafetyTests(unittest.TestCase):
    def test_no_eval_of_interactive_values(self):
        with tempfile.TemporaryDirectory() as dirname:
            marker = Path(dirname) / "should-not-exist"
            value = "$(touch " + str(marker) + ")"
            script = function_source("prompt_input", "prompt_required")
            bash = script + '\n' + 'prompt_input "Enter value" "" RESULT\nprintf "RESULT:%s\\n" "$RESULT"\n'
            proc = subprocess.run(["bash", "-c", bash], input=value + "\n", text=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("RESULT:" + value, proc.stdout)
            self.assertFalse(marker.exists())

    def test_refuses_existing_configuration(self):
        with tempfile.TemporaryDirectory() as dirname:
            file = Path(dirname) / "config.yaml"
            file.write_text("existing secret: unchanged\n")
            bash = function_source("preflight_fresh_install")
            bash += '\nprint_error() { :; }; print_info() { :; };\n'
            bash += 'CONFIG_FILE="$1"; COMPOSE_FILE="$2"; preflight_fresh_install\n'
            proc = subprocess.run(["bash", "-c", bash, "_", str(file), str(Path(dirname) / "compose.yaml")],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(file.read_text(), "existing secret: unchanged\n")

    def test_new_install_protects_created_files(self):
        with tempfile.TemporaryDirectory() as dirname:
            bash = function_source("preflight_fresh_install")
            bash += '\nprint_error() { :; }; print_info() { :; };\n'
            bash += 'CONFIG_FILE="$1"; COMPOSE_FILE="$2"; preflight_fresh_install; umask\n'
            proc = subprocess.run(["bash", "-c", bash, "_", str(Path(dirname) / "config.yaml"),
                                   str(Path(dirname) / "compose.yaml")],
                                  capture_output=True, text=True, timeout=10)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(int(proc.stdout.strip(), 8), 0o077)


if __name__ == "__main__":
    unittest.main()
