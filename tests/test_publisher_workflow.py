"""Offline import-graph and executable publishing guard checks; no live posts."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PublisherWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workflow = json.loads((ROOT / "workflows/03-publisher.json").read_text(encoding="utf-8"))
        self.nodes = {node["name"]: node for node in self.workflow["nodes"]}

    def run_code(self, name, value, references=None, run_index=0):
        self.assertIn(name, self.nodes, "The standalone publishing stage is required")
        script = """const data=JSON.parse(process.argv[1]);
const refs=data.references||{};
const vm=require('node:vm');
const context=vm.createContext({Buffer,TextEncoder,TextDecoder,
 $input:{first:()=>({json:data.value}),all:()=>[{json:data.value}]},
 $:n=>({first:()=>({json:refs[n]})}),$runIndex:data.runIndex});
vm.runInContext('(async function(){'+data.code+'})()',context)
.then(value=>process.stdout.write(JSON.stringify({value}))).catch(e=>process.stdout.write(JSON.stringify({error:e.message})));"""
        payload = dict(code=self.nodes[name]["parameters"]["jsCode"], value=value,
                       references=references or {}, runIndex=run_index)
        result = subprocess.run(["node", "-e", script, json.dumps(payload)], capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def test_standalone_import_uses_native_database_and_no_service(self):
        self.assertFalse(self.workflow["active"])
        self.assertIn("Claim One Approved Publication", self.nodes)
        self.assertNotIn("http://agent:8000", json.dumps(self.workflow))
        self.assertNotIn("/publish/tick", json.dumps(self.workflow))
        self.assertTrue(any(n["type"] == "n8n-nodes-base.postgres" for n in self.nodes.values()))

    def test_busy_job_cannot_claim_another_publication(self):
        claim = self.nodes["Claim One Approved Publication"]["parameters"]["query"]
        saved = self.nodes["Save Published Result"]["parameters"]["query"]
        self.assertIn("j.status IN ('approved','partial')", claim)
        self.assertNotIn("j.status IN ('approved','publishing'", claim)
        self.assertIn("p.status<>'published') THEN 'approved'", saved)

    def test_mutating_http_nodes_cannot_auto_retry_and_have_error_routes(self):
        writes = [n for n in self.nodes.values() if n["type"] == "n8n-nodes-base.httpRequest" and n["parameters"].get("method") in ("POST", "PUT")]
        self.assertGreaterEqual(len(writes), 4)
        for node in writes:
            self.assertFalse(node.get("retryOnFail", False), node["name"])
            self.assertEqual(node["onError"], "continueErrorOutput")
            self.assertTrue(self.workflow["connections"][node["name"]]["main"][1])

    def test_youtube_channel_guard_rejects_other_channel(self):
        refs = {"Verify Exact Media": {"asset": {"target_id": "UC_owner"}, "config": {"youtubeChannelId": "UC_owner"}}}
        bad = self.run_code("Verify YouTube Channel", {"items": [{"id": "UC_wrong"}]}, refs)
        self.assertIn("error", bad)
        good = self.run_code("Verify YouTube Channel", {"items": [{"id": "UC_owner"}]}, refs)
        self.assertNotIn("error", good)

    def test_youtube_session_guard_rejects_credential_exfiltration(self):
        refs = {"Verify Exact Media": {"asset": {"bytes": 10}}}
        bad = self.run_code("Validate YouTube Session", {"headers": {"location": "https://evil.example/upload"}}, refs)
        self.assertIn("error", bad)
        good = self.run_code("Validate YouTube Session", {"headers": {"location": "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc"}}, refs)
        self.assertIn("upload_url", good["value"][0]["json"]["checkpoint"])

    def test_instagram_owner_guard_uses_professional_user_id(self):
        refs = {"Verify Exact Media": {"asset": {"target_id": "178900"}, "config": {"instagramUserId": "178900"}}}
        good = self.run_code("Verify Instagram Account", {"data": [{"id": "app-scoped", "user_id": "178900", "account_type": "Business"}]}, refs)
        self.assertNotIn("error", good)
        bad = self.run_code("Verify Instagram Account", {"user_id": "178901", "account_type": "Business"}, refs)
        self.assertIn("error", bad)

    def test_instagram_polling_is_bounded_and_published_is_uncertain(self):
        refs = {"Validate Instagram Container": {"container_id": "18100"}}
        pending = self.run_code("Classify Instagram Container", {"status_code": "IN_PROGRESS"}, refs)
        self.assertEqual(pending["value"][0]["json"]["poll_state"], "wait")
        done = self.run_code("Classify Instagram Container", {"status_code": "IN_PROGRESS"}, refs, run_index=4)
        self.assertEqual(done["value"][0]["json"]["poll_state"], "failed")
        published = self.run_code("Classify Instagram Container", {"status_code": "PUBLISHED"}, refs)
        self.assertEqual(published["value"][0]["json"]["poll_state"], "uncertain")

    def test_approved_asset_guard_checks_target_url_disclosure_and_size(self):
        row = {"asset_id": "asset-1", "config": {"youtubeChannelId": "UC_owner"},
               "asset": {"id": "asset-1", "format": "youtube_short", "target_id": "UC_owner",
                         "title": "Approved title", "caption": "Approved description", "visibility": "private",
                         "made_for_kids": False, "contains_synthetic_media": True,
                         "sha256": "a" * 64, "bytes": 10, "media_url": "https://media.example.com/file.mp4"}}
        refs = {"Publisher Config": {"allowedMediaHosts": ["media.example.com"], "maxMediaBytes": 100}}
        good = self.run_code("Validate Approved Asset", row, refs)
        self.assertNotIn("error", good)
        for field, value in [("target_id", "UC_other"), ("media_url", "https://media.example.com@evil.example/file"),
                             ("made_for_kids", "false"), ("bytes", 101), ("visibility", "default")]:
            altered = {**row, "asset": {**row["asset"], field: value}}
            with self.subTest(field=field):
                self.assertIn("error", self.run_code("Validate Approved Asset", altered, refs))

    def test_instagram_result_requires_provider_permalink_for_exact_saved_id(self):
        refs = {"Validate Instagram Media ID": {"checkpoint": {"media_id": "18200"}}}
        good = self.run_code("Instagram Published Result", {"id": "18200", "permalink": "https://www.instagram.com/reel/abc/"}, refs)
        self.assertEqual(good["value"][0]["json"]["result"]["external_id"], "18200")
        for response in ({"id": "99999", "permalink": "https://www.instagram.com/p/unrelated/"},
                         {"id": "18200", "permalink": "https://attacker.example/p/abc"},
                         {"id": "18200"}):
            self.assertIn("error", self.run_code("Instagram Published Result", response, refs))

    def test_checkpoint_nodes_precede_irreversible_media_calls(self):
        edges = self.workflow["connections"]
        for origin, target in [("Save YouTube Session", "Restore Verified YouTube Binary"),
                               ("Restore Verified YouTube Binary", "Upload YouTube Bytes"),
                               ("Save Instagram Publish Intent", "Publish Instagram Container")]:
            self.assertIn(origin, edges)
            self.assertEqual(edges[origin]["main"][0][0]["node"], target)

    def test_crypto_output_restores_original_binary_before_size_verification(self):
        self.assertIn("Restore Downloaded Binary", self.nodes)
        self.assertEqual(self.workflow["connections"]["Hash Downloaded Media"]["main"][0][0]["node"], "Restore Downloaded Binary")
        self.assertEqual(self.workflow["connections"]["Restore Downloaded Binary"]["main"][0][0]["node"], "Verify Exact Media")


if __name__ == "__main__":
    unittest.main()
