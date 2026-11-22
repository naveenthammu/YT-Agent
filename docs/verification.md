# MiniMax shared-video verification — 20 November 2026

Fresh local results after the final behavior changes:

| Suite | Passed | Coverage |
| --- | ---: | --- |
| Python workflow/publisher tests |22|Native-node exports, references, inactive defaults, credentials, account/approval/publisher guards.|
| Storyboard JavaScript tests |6|One shared storyboard, MiniMax durations, trusted targets, finite spending limits, required prompts.|
| Planner-to-renderer integration |1|Actual exported planner creates one canonical edit and a shared Instagram destination, with one complete quote set.|
| Renderer/review JavaScript tests |23|MiniMax options, exact timing, alias exclusion, quote pairing, one preview/two metadata sets, immutable file checks.|
| Production/approval/publication SQL |20|Existing idempotency, approval identity/hash/replay/expiry, publication state and scheduling.|
| Rendering/review SQL |46|Atomic reservations, alias preview propagation, six-hour deadlines, saved IDs and legacy submitted-job continuity.|
| Shared-publication SQL |138|Exactly one generation and two approved targets, same bytes/hash/URL, India daily/month boundaries, global monthly caps, malformed/absent aliases, invalid numeric settings, replay/failure accounting.|
| Official Shotstack OpenAPI |Pass|Canonical MiniMax edits at 5/10/15-second shot lengths and every video/voice quote payload.|

Total: **52 workflow/JavaScript tests and 204 SQL assertions**, all passing. The ZIP is checked for inactive exports, placeholder credentials, archive integrity and content hashes.

JavaScript tests use node:vm with an n8n-like supported global allowlist. No browser URL/fetch/process/unrestricted require is assumed in Code nodes. HTTP response pairing was checked against pinned n8n 2.48.6 source.

SQL is executed in PGlite 0.5.17/PostgreSQL 18.7. A SHA256-compatible digest shim substitutes for pgcrypto; production still uses the real extension. The shared-boundary suite substitutes a fixed clock for now() to exercise exact India midnight/month boundaries. These are sequential database tests, not multi-session lock stress.

Independent review covered the canonical/alias lifecycle, one-render guarantee, quote/reservation paths and unchanged approval/publisher controls. No live n8n import, provider render, actual media-quality judgment, Telegram delivery or account publication was performed. These are still deployment checks.

## Reproduce from the repository

Python and Node.js are development tools only; the imported workflows need no Python/backend service.

```powershell
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/ai-video-planning.test.mjs tests/ai-video-pipeline.test.mjs tests/render-review.test.mjs
npm.cmd install --prefix .validation --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.5.17
node tests/workflow-sql.test.mjs
node tests/render-review-sql.test.mjs
node tests/shared-publication-sql.test.mjs
node scripts/validate-shotstack-edit.mjs
python tools/package_workflows.py
```

The schema validation command fetches official documentation only, not a rendering account. The ZIP contains six JSON exports, README, setup guide, this report and SHA256SUMS.json. It excludes credentials, application services and test dependencies.

Before scheduling, follow the setup guide's controlled account tests, verify the intended accounts/visibility, inspect the full Telegram preview and test rejection/replay. A live render consumes credits even in sandbox. Do not reset production quotas to repeat tests; use a later India day or an isolated test database.
