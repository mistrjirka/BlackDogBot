import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE=Path(__file__).resolve().parents[2] / "scripts" / "guarded-container-update.py"
spec=importlib.util.spec_from_file_location("guarded_container",MODULE)
guard=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class GuardedContainerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.digest="pyd4vinci/scrapling@sha256:"+"a"*64
        self.second="pyd4vinci/scrapling@sha256:"+"b"*64
        self.compose=("services:\n"
                      "  searxng:\n"
                      "    image: searxng/searxng:latest\n"
                      "    environment:\n"
                      "      - FLAG=yes\n"
                      "  scrapling:\n"
                      "    image: "+self.digest+"\n"
                      "    ports:\n"
                      "      - \"127.0.0.1:18733:8000\"\n"
                      "  crawler:\n"
                      "    image: old-crawler:0.9.4\n"
                      "volumes:\n"
                      "  data:\n")

    def test_only_scrapling_image_changes(self):
        updated,prev=guard.replaced_image(self.compose,self.second)
        self.assertEqual(prev,self.digest)
        self.assertIn("image: "+self.second,updated)
        self.assertIn("image: searxng/searxng:latest",updated)
        self.assertIn("image: old-crawler:0.9.4",updated)
        self.assertEqual(guard.replaced_image(updated,self.digest)[0],self.compose)

    def test_refuse_when_service_absent(self):
        with self.assertRaisesRegex(RuntimeError,"absent"):
            guard.replaced_image("services:\n  searxng:\n    image: searxng:latest\n",self.second)

    def test_atomic_backup_and_private_report(self):
        target=self.root/"config.yaml"
        target.write_text(self.compose)
        guard.write_atomic(target,guard.replaced_image(self.compose,self.second)[0])
        self.assertIn(self.second,target.read_text())
        self.assertEqual(target.stat().st_mode & 0o777,0o600)

    def test_check_for_new_digest_does_not_recreate_containers(self):
        p=self.root/"compose.yaml"
        p.write_text(self.compose)
        fake_digests=json.dumps([self.second])
        with patch.object(guard, "command", side_effect=["pulled", fake_digests]) as call:
            result=guard.check_for_update(p)
        self.assertEqual(result["status"], "update_available")
        self.assertEqual(result["available_image"], self.second)
        self.assertEqual(len(call.call_args_list), 2)
        self.assertTrue(all("compose" not in args[0][0] for args in call.call_args_list))
        self.assertEqual(p.read_text(), self.compose)

    def test_both_images_are_updated_independently(self):
        searx_digest="searxng/searxng@sha256:"+"d"*64
        updated, old = guard.replaced_image(self.compose, searx_digest, "searxng")
        self.assertEqual(old, "searxng/searxng:latest")
        self.assertIn(self.digest, updated)
        self.assertIn(searx_digest, updated)
        self.assertEqual(guard.replaced_image(updated,"searxng/searxng:latest","searxng")[0],self.compose)

    def test_searxng_discovers_official_digest_only(self):
        p=self.root/"compose.yaml"
        p.write_text(self.compose)
        candidate="searxng/searxng@sha256:"+"e"*64
        with patch.object(guard,"command",side_effect=["pull successful",json.dumps([candidate])]) as call:
            result=guard.check_for_update(p,"searxng")
        self.assertEqual(result["status"],"update_available")
        self.assertEqual(result["available_image"],candidate)
        self.assertEqual(call.call_count,2)
        self.assertEqual(p.read_text(),self.compose)

    def test_unchanged_scraper_is_noop(self):
        import argparse
        args=argparse.Namespace(service="scrapling",compose=self.root/"compose.yaml",
            probe=self.root/"probe.mjs",env_file=self.root/"scrapling.env",
            searx_settings=self.root/"settings.yml",report_dir=self.root/"reports",
            image=self.digest,chat_id=None,canary_port=18734,production_port=18733)
        args.compose.write_text(self.compose)
        args.probe.write_text("")
        args.env_file.write_text("SCRAPLING_MCP_AUTH_TOKEN=fake")
        args.env_file.chmod(0o600)
        with patch.object(guard,"command") as call:
            result=guard.update(args)
        self.assertEqual(result["status"],"unchanged")
        call.assert_not_called()

    def test_image_pinning_validation(self):
        self.assertTrue(guard.DIGEST_RE.fullmatch(self.digest))
        updated, previous = guard.replaced_image(self.compose, "searxng/searxng@sha256:"+"c"*64, "searxng")
        self.assertEqual(previous, "searxng/searxng:latest")
        self.assertIn("searxng/searxng@sha256:"+"c"*64, updated)
        self.assertIn(self.digest, updated)
        self.assertFalse(guard.DIGEST_RE.fullmatch("pyd4vinci/scrapling:latest"))
        self.assertTrue(guard.DIGEST_RE.fullmatch("searxng/searxng@sha256:"+"a"*64))

if __name__=="__main__":
    unittest.main()
