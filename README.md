# YT-Agent — one daily AI video, two platforms

Standalone n8n workflows that research a topic, generate **one MiniMax video**, send it to Telegram, and publish **that same file** to YouTube Shorts and Instagram Reels only after your approval. No separate application/backend service is required.

**[Download the workflow ZIP](dist/YT-Agent-n8n-workflows.zip)** · **[Setup and upgrade guide](docs/n8n-setup.md)**

All six workflows arrive inactive. Account credentials, niche, language, sources and voice still need configuration. No paid generation, Telegram delivery or social post was performed during development.

## Defaults designed to control spending

| Setting | Default |
| --- | --- |
| Generated content | One shared 30-second portrait video, three 10-second moving shots |
| Video model | MiniMax H3, 768p generation; final 720×1280 H264/AAC MP4 |
| Audio | Selected ElevenLabs narration; generated scene audio is muted |
| Generation frequency | At most one attempt per India calendar day, including failed/rejected attempts |
| Production schedule | 09:00 Asia/Kolkata, disabled until configured |
| Job credit reservation limit | 16 credits, including a 25% estimate margin |
| Monthly credit reservation limit | 500 credits per India calendar month |
| Text planning limit | US$0.05 per job using configured model price estimates |
| Render/publisher polling | Hourly; about 1,440 combined executions per 30 days before other workflows |
| Publication | Public on both platforms only after Telegram approval; publisher additionally disabled by default |

The Instagram destination references the YouTube master asset. It cannot enter generation or reserve another render budget. One file is previewed in Telegram with both destinations' exact metadata. Approval queues two independent uploads of identical bytes, URL and SHA256; it does not generate the video twice.

## Workflows

| File | Responsibility |
| --- | --- |
| [00 — Database](workflows/00-database-setup.json) | Create/update shared job, media, approval and budget state without deleting records. |
| [01 — Production](workflows/01-production.json) | Research permitted sources and write one timed storyboard for both platforms. |
| [04 — Render and review](workflows/04-render-and-review.json) | Quote every shot/narration, reserve budget, generate one video and send Telegram review. |
| [02 — Approval](workflows/02-telegram-approval.json) | Accept the exact Approve/Reject button only from your authorized Telegram users. |
| [03 — Publisher](workflows/03-publisher.json) | Verify approved hashes/accounts and upload the shared video to each platform. |
| [05 — Feedback](workflows/05-analytics-feedback.json) | Collect recent post metrics for later topic selection. |

Required accounts: n8n, PostgreSQL, OpenAI, Shotstack, Telegram, YouTube OAuth and Instagram professional publishing access. MiniMax generation uses your existing Shotstack key; no separate MiniMax credential is required. Target n8n version: **2.48.6**.

## Cost and profitability

A 30-second video is approximately **12 credits / US$2.40 / ₹230 before tax**, using current MiniMax 768p rates, about 400 narration characters and ₹95/USD for planning. At one video daily, allow roughly **₹11,000–₹14,000/month** including modest hosting, tax/FX and operating headroom. The default 500-credit monthly reservation cap represents about US$100 of PAYG credits before tax, not a subscription requirement. Actual charges depend on live quotes and account pricing. [Provider rates](https://help.shotstack.io/en/articles/17312748-understanding-shotstack-credit-consumption), [credit pricing](https://shotstack.io/pricing/)

The workflow obtains quotes before generation and reserves their sum plus rendering and a 25% margin. These are application budget guards, not provider billing guarantees. Failed/rejected generations can still cost money. Reservations are retained after failures and ambiguous outcomes; automatic regeneration is off. Set provider-side spending controls too.

Profitability depends on your revenue. Measure actual cost and earnings per accepted video before increasing duration or frequency. This workflow does not guarantee monetization, views or revenue.

## Upgrade and verification

For an existing installation, disable schedules, back up the database, import the updated exports and rerun **00** once to add the shared-media field and monthly-budget table. Reapply credentials and configuration, then create a fresh job. Keep only one Telegram Trigger for the bot. Do not reset old render/publication checkpoints. See the [complete upgrade procedure](docs/n8n-setup.md).

Offline tests exercise shared-file reuse, only one generation reservation, India daily/monthly limits, one-preview/two-destination approval, replay/hash checks and publication state. See [verification details](docs/verification.md). **Live n8n import, provider generation quality and account publishing remain unverified.**

Shots may vary in subject consistency; narration is continuous rather than guaranteed lip-sync. Files must fit the complete 45 MB Telegram review. This version focuses on shared Shorts/Reels; separate long-form videos, images, comment replies, livestreams and customer account isolation are not included.
