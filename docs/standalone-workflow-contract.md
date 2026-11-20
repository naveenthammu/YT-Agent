# Shared MiniMax workflow contract

One operator-controlled n8n instance and one YouTube/Instagram credential pair. Native n8n exports only; PostgreSQL holds durable state. All exports inactive. The user authorized one daily generated video shared across both destinations, with Telegram approval before posting.

## Stored state and migrations

Workflow 00 is the authoritative DDL. Tables: jobs (frozen config, plan, manifest, approvals, reserved credits), assets (media and destination metadata), publications (one per destination asset), audit, budgets (daily attempts), credit_budgets (calendar-month reserved credits).

`assets.source_asset_id` is a nullable UUID self-reference added idempotently for existing installations. A new shared job has exactly two asset rows: a `youtube_short` canonical row, initially planned with a null source; an `instagram_reel` alias initially `shared_waiting`, pointing to the master. Both share job/revision/duration/scenes but carry their own destination account and visibility. No new unique-key changes to publications are needed. Workflow 00 creates credit_budgets if missing; no destructive reset occurs.

## Production and budget contracts

Config mode: `minimax_shared_v1`, `reuseVideoAcrossPlatforms:true`, formats in order `youtube_short`,`instagram_reel`. Model `minimax-h3-text-to-video`, generated resolution 768p, portrait 9:16. Default 30 seconds, requested shot 10 seconds, maxScenes 6 (up to 12). Whole shots 5..15 seconds sum exactly to total 10..60. One planner request creates one storyboard; trusted timing/accounts overwrite model choices. Instagram metadata is derived from that master rather than a second planner response.

One generation attempt per Asia/Kolkata calendar day, including manual and scheduled attempts. Scheduled idempotency keys use the same India date. Duplicate keys do not consume another slot; failed attempts remain counted. The default 09:00 schedule is disabled until the owner configures it.

Defaults: text estimate cap $0.05/job, input/output price estimates $0.40/$1.60 per million tokens,16 reserved credits/job,500 reserved credits/India calendar month. Numeric finite positive settings are required. Render credits quote every visual+voice component, add PAYG rendering and 25% margin. Monthly credits use the shared operator key `generation:YYYY-MM`; canonical asset/job/month reservations are transactional and replay-safe. The alias never enters generation/reservation. Retain reservations after failures or uncertainty, because charges may have occurred. Application caps are estimates, not provider billing guarantees.

## Rendering and media identity

Only null-source canonical YouTube assets can claim new generation. MiniMax options include 9:16, 768p,enhancePrompt:false. Do not send unsupported generateAudio. The rendered video asset uses volume:0 to mute native sound; quote assets omit that edit-only property. Selected ElevenLabs voice is generated once as a continuous track. Final output 720×1280 H264/AAC MP4.

New jobs receive a six-hour polling deadline. Existing saved render IDs/checkpoints are retained even for older modes; old planned jobs are not silently converted. Hourly polling uses read requests, never repeated paid submission. Ambiguous outcomes require reconciliation.

Verified master media is copied to its matching alias only when job/revision/duration/type agree. Review requires exactly the expected two entries for a new shared job, ready with identical URL/hash/bytes. Full file <=45,000,000bytes, dimensions/codecs verified, duration within 0.5 seconds of requested. Downloaded bytes are SHA256-hashed, not inferred from provider IDs.

## Approval and publishing

Freeze the manifest using PostgreSQL jsonb, including both destination assets and source_asset_id. Hash canonical `manifest::text` with SHA256 in PostgreSQL. Send one complete master file, exact metadata for both destinations, then one final approval message. Mark both preview records only when their frozen media identity matches the verified preview. No model output can approve or pick an unconfigured account.

Native Telegram Trigger accepts callback_query. Parameterized SQL verifies token hash, expiry, user, chat, exact message, status, revision and manifest hash. Approve consumes the token and queues two publications; reject queues none. Replays and changed/unauthorized callbacks cannot approve. The raw token is not persisted; the hash is.

03 claims one approved publication per execution using row locks and durable job state, reads its target/metadata from the frozen manifest, checks authenticated account and re-downloads/verifies identical bytes. Success on one platform never recreates its publication while the other is pending. A publishing/uncertain job blocks another claim; no blind retries of mutating calls. Provider resumable session/container/publish intent are saved before final writes. Publisher polls hourly and additionally requires explicit publishingEnabled.

05 reads at most 20 recent published assets and stores metrics for planning; no revenue/retention or monetization guarantee.

## Runtime and test limits

Target n8n 2.48.6. Code nodes avoid unsupported URL/fetch/process/require globals; HTTP/Crypto/Postgres/Telegram use native nodes. Credentials contain secrets; config only IDs/preferences/estimates. Protect the editor, database, backups and saved session URLs. Source requests require permitted allowlisted public HTTPS sources, robots checks, native SSRF protection and egress restrictions.

Tests use restricted JavaScript VM fixtures and real PGlite PostgreSQL semantics, with a SHA256 digest shim and fixed clock where needed. They do not constitute live n8n/provider execution or multi-session concurrency stress. See verification.md for fresh results.
