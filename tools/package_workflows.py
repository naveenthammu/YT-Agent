"""Build a workflow-only handoff archive. Standard library; no network calls."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [ROOT / "README.md", ROOT / "docs/n8n-setup.md", ROOT / "docs/verification.md"]
FILES += sorted((ROOT / "workflows").glob("*.json"))
assert len(FILES) == 9, "Expected six workflow exports and three documents"
for path in FILES[3:]:
    workflow = json.loads(path.read_text(encoding="utf-8"))
    assert workflow["active"] is False, f"Active export: {path.name}"
    for node in workflow["nodes"]:
        for credential in node.get("credentials", {}).values():
            credential_id = credential.get("id")
            assert credential_id is None or credential_id.startswith(("CONFIGURE_", "REPLACE_WITH_")), f"Non-placeholder credential reference in {path.name}"
            assert credential["name"].startswith("YT-Agent "), f"Unexpected credential name in {path.name}"

output = ROOT / "dist/YT-Agent-n8n-workflows.zip"
output.parent.mkdir(exist_ok=True)
manifest = {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest() for path in FILES}
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in FILES:
        archive.write(path, str(path.relative_to(ROOT)).replace("\\", "/"))
    archive.writestr("SHA256SUMS.json", json.dumps(manifest, indent=2) + "\n")
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert len(archive.namelist()) == 10
    for name, digest in manifest.items():
        assert hashlib.sha256(archive.read(name)).hexdigest() == digest
print(json.dumps({"archive": str(output), "files": 10, "bytes": output.stat().st_size,
                  "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))
