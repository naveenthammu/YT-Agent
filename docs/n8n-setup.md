# MiniMax shared-video setup

Importable native n8n workflows for one daily AI video, reviewed once in Telegram, then uploaded to YouTube Shorts and Instagram Reels. No custom Python service or local renderer is deployed. Target: n8n **2.48.6**, source-checked; live account execution remains your setup step.

## Import and upgrade

1. Disable existing production/render/publisher schedules and back up your PostgreSQL database.
2. Import the six JSON files from `workflows/` or the ZIP and save them inactive. Replace previous versions rather than leaving duplicate schedules active. [n8n import/export](https://docs.n8n.io/workflows/export-import/)
3. Select the real credentials in every matching node. Placeholder names/IDs do not automatically authorize access.
4. Run **00 database setup** once on the same database used by every workflow. For upgrades it adds `assets.source_asset_id` and the monthly `credit_budgets` table with idempotent statements. It does not delete old jobs or approvals. The role needs schema/table/ALTER permissions and `pgcrypto` support; enable that extension through your administrator if needed.
5. Configure 01, the Telegram Trigger and publisher as below. Activate 02 before creating a fresh Telegram review. Keep one active trigger per bot.
6. Test manually before enabling daily production and hourly polling.

Operational sequence: **00 → 01 → 04 → Telegram decision through 02 → 03 → 05 feedback**. The database connects workflows; no pasted webhook-to-webhook API URLs are needed.

The new production mode is `minimax_shared_v1`. Old planned slide/Seedance jobs retain their frozen configuration and fail preflight with a fresh-job instruction. Already-submitted renders retain their saved IDs and are polled without a new submission. Existing approved/published records remain intact. Reject an older pending review if you no longer want it posted; never rewrite its manifest or reset checkpoints/credit counters.

## Credentials and accounts

| Name in the workflows | n8n credential |
| --- | --- |
| YT-Agent Database | Postgres, pointing to the same reachable database in all workflows |
| YT-Agent OpenAI | Header Auth: `Authorization` = `Bearer YOUR_API_KEY` |
| YT-Agent Shotstack | Header Auth: `x-api-key` = your Shotstack key for the chosen environment |
| YT-Agent Telegram | Native Telegram API credential for your review bot |
| YT-Agent YouTube | Native YouTube OAuth2 API credential for your intended channel |
| YT-Agent Instagram | Header Auth: `Authorization` = `Bearer YOUR_INSTAGRAM_ACCESS_TOKEN` |

Put secrets only in n8n Credentials, never inside workflow JSON/Code nodes/SQL. Use TLS for database connections across networks. MiniMax generation uses the Shotstack credential; a separate MiniMax subscription/key is not needed.

YouTube needs an OAuth-authorized account and enabled YouTube Data API. Allow upload and read access needed for channel verification and feedback; follow the n8n credential UI's OAuth redirect URI. Instagram requires a professional account and app/token access for Instagram Login, including `instagram_business_basic` and `instagram_business_content_publish`. Freeze the exact channel/user IDs in 01; 03 verifies the authenticated identities before posting. Rotate/refresh Instagram credentials when required; the native YouTube OAuth credential handles its refresh flow. [YouTube OAuth](https://developers.google.com/youtube/v3/guides/authentication), [Instagram publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)

## Required production configuration

In **Production Config** in 01, fill:

- `niche`, `language`, `visualStyle`, and a supported `shotstackVoice`.
- One to three permitted public `sourceUrls` and exact `allowedSourceHosts`; set `sourcePermissionConfirmed` only for sources you can use.
- `youtubeChannelId`, `instagramUserId`, `telegramChatId`, and numeric authorized `approverIds` as strings.
- Review the budget presets and current text-model prices. Your model/voice/account must be available on the provider account.

Keep `formats: ['youtube_short','instagram_reel']`, `reuseVideoAcrossPlatforms: true`, `mediaGeneration: 'minimax_shared_v1'`, `videoModel: 'minimax-h3-text-to-video'` and `videoResolution: '768p'`. This package makes a single shared portrait video. Separate long videos and image posts are outside this mode.

The default is **30 seconds**, three 10-second shots. `shortDurationSeconds` allows 10–60 whole seconds; `videoShotSeconds` allows 5–15. `maxScenes` defaults to 6 and permits up to 12. Trusted timing is calculated by the workflow, not accepted from model output. Longer videos can exceed the preset budget and will stop before rendering unless you deliberately adjust the limits.

Default Shotstack stage is **v1**, for production output without a sandbox watermark. A sandbox key requires `shotstackStage: 'stage'`; AI generation still costs credits there. YouTube visibility defaults to **public**, like Instagram. Set YouTube to private explicitly for an intended private test; Instagram has no equivalent private-upload test mode. Nothing publishes without the reviewed approval and enabled publisher.

## Spending controls

| Control | Default / behavior |
| --- | --- |
| `maxJobsPerDay` | 1 attempt per Asia/Kolkata calendar day, manual and scheduled combined |
| `maxEstimatedTextCostUsd` | $0.05 per planning job |
| `textInputUsdPerMillion` / `textOutputUsdPerMillion` | $0.40 / $1.60 estimates; verify for your selected model |
| `maxRenderCreditsPerJob` | 16 reserved credits, including rendering and 25% estimate margin |
| `maxRenderCreditsPerMonth` | 500 reserved credits across the operator's jobs per India calendar month |

Each generated visual shot and the narration are quoted with their exact prompts/options/durations. Quotes must be complete, finite, paired to the correct component and have `ceiling: false`. The sum plus rendering and 25% is reserved atomically against both job and monthly limits before the paid render POST. The Instagram alias cannot claim generation or reserve a second budget. Quote breakdowns and reserved amounts are kept in `assets.render_checkpoint`, `jobs.render_credits_reserved` and `credit_budgets`.

Failed/rejected jobs count toward the daily attempt limit. Paid-generation reservations are retained after failure or uncertainty because some provider charges may have occurred. There is no automatic reroll or daily catch-up. Do not clear quotas/checkpoints to force retries. Text planning may already have incurred a small charge if rendering later fails its quote/cap check.

Application reservations do not lock provider prices or guarantee the final bill. Configure provider alerts/limits too. Rejected Telegram content is not posted, but generation charges are not reversed. Generation costs apply in sandbox as well. [Quote/billing semantics](https://shotstack.io/docs/guide/generating-assets/ai-generation-pricing/)

At published MiniMax H3 768p rates, 30 seconds uses about **11.25 generation credits**, plus roughly 0.25 for 400 narration characters and 0.5 for PAYG rendering. That is about 12 credits = **$2.40 / ₹230 before tax** using ₹95/USD. One such video daily is about ₹6,900/month before hosting/taxes/FX. A planning budget of **₹11,000–₹14,000/month** leaves room for modest self-hosting and operational headroom. No paid quality test has established your actual acceptance rate; track cost and revenue per accepted post before scaling. [Current rates](https://help.shotstack.io/en/articles/17312748-understanding-shotstack-credit-consumption), [credits/pricing](https://shotstack.io/pricing/)

## Rendering, sharing and review

MiniMax H3 generates full-screen moving shots at 768p and 9:16. Final output is 720×1280 H264/AAC MP4. Each shot is 5–15 seconds. The provider generates native audio; the asset is muted with `volume: 0` so separate ElevenLabs narration is heard. `generateAudio` is not a MiniMax option and is not sent. Prompt enhancement is disabled explicitly; the storyboard supplies detailed prompts. [MiniMax model options](https://shotstack.io/models/minimax-h3/)

One canonical YouTube asset owns generation. The Instagram destination has `source_asset_id` pointing to it and waits in `shared_waiting`. When the master passes duration, codec, dimension, byte-size and SHA256 checks, the workflow copies the exact media URL/hash/bytes to that alias. Both destinations must be ready and match before review. There is no second render or image/slide fallback.

The full file must be at most **45,000,000 bytes**, and duration within 0.5 seconds of the requested length. Shot consistency, factual correctness, narration pacing and appearance still need human review. Narration is continuous, not guaranteed lip-sync or word-aligned captions.

Telegram receives **one complete file**, then exact metadata for **both** accounts, followed by **one Approve/Reject message**. Preview records mark both entries only after their file identity matches. Approval is bound to user, chat, message, one-use token, expiry, job revision and manifest hash. Reject creates no publications; approving queues two uploads of that same approved file. Changed/replayed/unauthorized/expired approval cannot queue posts.

## Schedules and controlled testing

All exports are inactive. To enable daily creation, configure 01, set `enableScheduledProduction: true`, enable its disabled **Daily Production - Opt In** node, and activate the workflow. Default: **09:00 Asia/Kolkata**. The daily key and quota use India calendar dates, avoiding the previous rolling-24-hour boundary issue.

04 and 03 poll **hourly**. That is about 1,440 combined executions per 30 days, plus roughly 90 daily production/metrics/approval runs and any manual tests. This is a planning estimate; monitor your actual execution count. Faster intervals increase hosted n8n usage. The publisher handles one destination per run, so both posts may take two ticks after approval. Run 04 or 03 manually to advance an existing job sooner without generating a second video.

New render polling deadlines are six hours. A saved render ID is reused throughout polling; a timeout or ambiguous outcome stops for reconciliation, not automatic resubmission.

For testing, keep 03 inactive and `publishingEnabled: false`, configure a short job and run 01/04. These manual runs can incur provider charges and send Telegram messages. Check the complete preview and both destination IDs. Reject the job and confirm no publications were queued. Test approval with a separate job on a later India calendar day, or a separate disposable test database, without resetting production quotas. Approve only content you intend to publish; then enable 03 and run it for each destination. Replaying the button must do nothing.

## Publishing and uncertain outcomes

In **Publisher Config**, set `allowedMediaHosts` to the exact Shotstack Serve host used by your generated files (normally `cdn.shotstack.io`). Review its size limit and set `publishingEnabled: true` only when ready. Keep the files immutable and available until both uploads complete.

The publisher reads target/metadata from the frozen manifest and rechecks downloaded bytes/hash and authenticated account. YouTube's resumable session and Instagram's container/publish intent are saved before the irreversible calls. Automatic mutation retries are disabled. An interrupted `publishing` row or `uncertain` result must be reconciled against the saved provider session/container and account; never blindly reset it to pending. The first successful platform is not reposted if the second fails. [YouTube resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)

Telegram callback acknowledgement occurs after the database decision. A failed acknowledgement does not mean approval failed. Keep one webhook per bot; registering a test webhook can replace production registration. Activate 02 before issuing a fresh review. [Telegram testing limitations](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.telegramtrigger/common-issues/)

## Hosting and source access

Use a reachable PostgreSQL database, persistent n8n credentials/encryption key, database backups and public HTTPS for Telegram callbacks. On n8n Cloud, localhost is not your PC. On self-hosted n8n behind one reverse proxy, an example configuration is:

```dotenv
N8N_HOST=automation.example.com
N8N_PROTOCOL=https
N8N_EDITOR_BASE_URL=https://automation.example.com/
N8N_WEBHOOK_URL=https://automation.example.com/
N8N_PROXY_HOPS=1
N8N_SSRF_PROTECTION_ENABLED=true
```

Use the actual proxy-hop count and forward original host/protocol headers. The native Telegram Trigger registers its own webhook. `N8N_WEBHOOK_URL` applies to the targeted current n8n version. [Reverse proxy setup](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/configure-webhook-urls-with-reverse-proxy.md)

Research supports one to three permitted static public HTTPS pages/feeds, with robots checks and no redirects, authenticated/paywalled pages or social-platform HTML scraping. URLs use exact ASCII DNS host allowlists and no credentials/ambiguous paths. Enable n8n SSRF protection plus appropriate network egress rules; a hostname string check alone does not protect against DNS rebinding. Do not add arbitrary research domains to an SSRF bypass list. [SSRF protection](https://docs.n8n.io/deploy/host-n8n/configure-n8n/security/enable-ssrf-protection.md)

Self-hosted Community Edition is available for permitted use without a cloud subscription; hosting and provider usage remain separate. n8n Cloud is execution-priced. Avoid paying for a higher plan merely to poll idle workflows frequently. Check the current license before reselling/embed-hosting n8n for customers. [n8n pricing](https://n8n.io/pricing/), [license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)

## Feedback and maintenance

05 reads metrics for up to 20 recent published assets and saves them in audit records. It does not send reports or provide full revenue/retention analytics. No monetization or profitability is guaranteed. Monitor provider balances, actual cost per approved post, failures, credentials and backup restores.

Execution-data retention is disabled by default; the database contains durable audit/checkpoint state. Provider session URLs, callback tokens and editor access are sensitive. Protect database backups and n8n credentials. See [verification details](verification.md) for local tests and their limits. No live generation, Telegram delivery or platform publication occurred during development.
