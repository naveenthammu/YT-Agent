# YT Autopilot

A self-hosted system that finds trending topics in your niche, writes a script, creates a narrated and captioned video with a thumbnail, sends it to your phone for a one-tap review, publishes it, and reports the stats every evening. It costs ₹0–1,500 a month to run.

```
 9:00 AM  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 schedule │ Trend signals│──▶│ AI picks the │──▶│ AI writes    │──▶│ Studio makes │
          │ Google Trends│   │ best topic   │   │ the script   │   │ the video:   │
          │ YouTube top  │   │ (no repeats, │   │ (random style│   │ voice, b-roll│
          │ your winners │   │ learns from  │   │ every time)  │   │ captions,    │
          └──────────────┘   │ your stats)  │   └──────────────┘   │ thumbnail    │
                             └──────────────┘                      └──────┬───────┘
                                                                          ▼
          ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────────────┐
 9:30 PM  │ Daily report │◀──│ Published +  │◀──│ Telegram on your phone:          │
 schedule │ on Telegram  │   │ logged       │   │ ✅ Publish  🔁 Redo  ❌ Reject     │
          └──────────────┘   └──────────────┘   └──────────────────────────────────┘
                     Any failure anywhere → instant Telegram alert
```

---

## 1. Read this first: four rules that decide whether you get paid

**1. YouTube does not pay for "template" AI channels.** Since 16 July 2026, YouTube's monetization rules name three kinds of *inauthentic content* that cannot earn ads:
- generic, repetitive or template-based videos with little variation between uploads,
- off-putting content,
- AI personas giving health, finance or legal advice.

Reviewers judge the **whole channel**, and a channel can lose monetization whether or not AI made the videos. This system is built to stay on the right side of that line:
- it picks a different style for every video,
- it writes in your own voice (`creator_notes`),
- it refuses advice topics,
- it never invents facts,
- you approve every video before it goes out.

Keep that review step on. Also post some content of your own now and then (your face or your own voice).

**2. Videos uploaded through the API stay private until Google approves your project.** YouTube locks every video uploaded through an *unverified* Google Cloud project to private, and you cannot appeal it. That's why the system starts in **manual mode**:
- you get a Telegram message with the finished video, title, description and tags,
- uploading it from the YouTube app takes about 2 minutes,
- meanwhile you apply for the API audit (section 5), and once approved you switch on full auto-publishing.

**3. The bar for monetization goes up on 1 February 2027.**
- **Today:** 1,000 subscribers plus either 4,000 watch hours (past 12 months) or 10 million Shorts views (past 90 days).
- **New applicants from 1 Feb 2027:** 8,000 watch hours or 20 million Shorts views.

A channel starting now will most likely apply after that date, so plan for the higher numbers. That's why the strategy in section 7 mixes daily Shorts (to grow) with weekly long videos (to build watch hours).

**4. Nothing here guarantees income.** Most automated channels fail because their videos are interchangeable. Your edge is real expertise, consistency and learning from your numbers. The system handles the busywork.

---

## 2. What it costs per month

| Item | Choice | Cost |
|---|---|---|
| Server | Oracle Cloud Always Free Arm VM (2 OCPU / 12 GB since June 2026), or any 4 vCPU / 8 GB VPS | ₹0, or roughly ₹600–1,500 |
| Domain | Free DuckDNS subdomain, or your own domain | ₹0–800 a year |
| Script AI | DeepSeek Flash (or any OpenAI-compatible API) | **under ₹1 per video**; about ₹30 for 30 videos |
| Voice | Kokoro TTS, self-hosted | ₹0 |
| Stock footage | Pexels and/or Pixabay API | ₹0 |
| n8n, YouTube API, Telegram | Self-hosted / free tiers | ₹0 |
| **Total** | | **About ₹0–1,500 a month** |

On the 2-OCPU free server, a Short takes about 2–5 minutes to render and a 7-minute long video about 15–30 minutes. That's fine for 1–3 videos a day.

---

## 3. Quick start on your Windows PC (your n8n at D:\n8n)

Your n8n is installed directly on Windows (`D:\n8n\start-n8n.bat`, with a Cloudflare tunnel for webhooks). Docker Desktop only runs the two helpers n8n calls:
- **kokoro:** the free voice,
- **studio:** the video renderer and dashboard, on `http://localhost:8000`.

Videos only get made while the PC and n8n are on.

1. **Stock-footage key.** Put at least one in `.env`:
   - **Pixabay** (instant): log in at pixabay.com/api/docs and the key is shown on that page,
   - or **Pexels**.
2. **Start the helpers.** Start Docker Desktop, then right-click **start-local.ps1** and choose **Run with PowerShell**. It fills in `.env` and starts kokoro and studio. The first run downloads about 3 GB.
3. **Import the workflows.** Close n8n, then double-click **import-workflows.bat**. It imports the 3 Autopilot workflows (plus the 6 MiniMax workflows from section 10, inactive) into `D:\n8n\data`. Re-run it any time you update the workflow files.
4. **Start n8n** with `D:\n8n\start-n8n.bat` and log in.
5. **Add credentials** as in **3.3** below.
6. **Edit the Config nodes:**
   - workflow 1: niche, `creator_notes`, `telegram_chat_id`, `llm_model`,
   - workflow 2: `channel_id`, `telegram_chat_id`, and `dashboard_url` (use the `DASHBOARD_TOKEN` from `.env`),
   - workflow 3: the chat ID in its Telegram node.

   Leave `studio_url` as `http://localhost:8000`. Error alerts are already linked.
7. **Test:** open workflow 1 and click **Execute workflow**. The finished video arrives in Telegram as a playable video (if it's under 48 MB), followed by the review or upload message.

Notes:
- **Approval links** (Publish/Redo/Reject) use your Cloudflare tunnel, so they work from anywhere. The quick-tunnel URL changes every time n8n restarts, so only links sent since the last restart work.
- **Download and dashboard links** use this PC's Wi-Fi IP, so they only open from home Wi-Fi.
- **YouTube OAuth redirect URI:** `http://localhost:5678/rest/oauth2-credential/callback`

When you want it running 24/7, move to a server with section 3A.

## 3A. Setup on a 24/7 server (about 1 hour, once)

### 3.1 Get your keys (all free)
| Key | Where | Used for |
|---|---|---|
| LLM API key | platform.deepseek.com (or Kimi, Gemini, OpenRouter, etc.) | Writing the script |
| Pixabay or Pexels API key | pixabay.com/api/docs (instant) or pexels.com/api | Stock video |
| YouTube Data API key | console.cloud.google.com → new project → enable **YouTube Data API v3** → Credentials → API key | Trending videos, stats |
| Telegram bot token | Telegram → @BotFather → `/newbot` | Approvals, alerts, reports |
| Telegram chat ID | Send your bot any message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` | Where messages go |
| YouTube channel ID | YouTube Studio → Settings → Channel → Advanced (starts with `UC`) | Daily stats |

### 3.2 Server
1. Create an Ubuntu 22.04/24.04 server and open ports **80** and **443**. On Oracle, open them in the subnet's security list **and** in the OS firewall.
2. Point your domain (an A record) at the server's IP.
3. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Copy this folder to the server, then:
   ```bash
   cd yt-autopilot
   cp .env.example .env && nano .env      # fill DOMAIN, N8N_ENCRYPTION_KEY (openssl rand -hex 24), PEXELS_API_KEY, DASHBOARD_TOKEN
   docker compose --profile server up -d --build
   docker compose --profile server ps     # all 4 services should be "running"
   ```
5. Open `https://YOUR_DOMAIN` and create your n8n owner account.

### 3.3 Add credentials in n8n (Credentials → Add credential)
| Name it | Type | Fields |
|---|---|---|
| LLM API Key | **Header Auth** | Name `Authorization`, Value `Bearer YOUR_LLM_KEY` |
| YouTube API Key | **Query Auth** | Name `key`, Value `YOUR_YOUTUBE_API_KEY` |
| Telegram | **Telegram API** | Bot token |
| YouTube OAuth | **YouTube OAuth2 API** | Only needed for auto-publishing (section 5) |

### 3.4 Import the workflows
Go to **Workflows → Import from file** and import the three files in `workflows/autopilot/`, then:
1. **Pick credentials.** Click every node marked with a red warning and choose the matching credential.
2. **Edit Config (workflow 1).** Open its **Config** node and set:
   - your niche, audience and `creator_notes` (this is what makes the videos sound like you),
   - `telegram_chat_id`,
   - `llm_model` (check the exact model name in your provider's docs).
3. **Edit Config (workflow 2).** Set `channel_id`, `telegram_chat_id` and `dashboard_url`.
4. **Edit workflow 3.** Put your chat ID in its Telegram node.
5. **Turn on error alerts.** In workflows 1 and 2, open **Settings → Error workflow** and choose *YT Autopilot - 3. Error Alerts*.
6. **Test.** Open workflow 1 and click **Execute workflow**. Within a few minutes you should get a Telegram message with your first video.
7. **Activate.** Switch all three workflows to **Active**.

---

## 4. What the main Config settings do

| Field | What it does |
|---|---|
| `channel_niche`, `audience` | Keeps every topic on-brand |
| `creator_notes` | Your opinions, experience and phrases. **The most important field for staying monetizable.** |
| `video_format` | `short` (vertical, under 60 s) or `long` (16:9, 6–8 min) |
| `video_styles` | Rotating structures, separated by `\|`; one is picked at random each run |
| `voice`, `speed` | Kokoro voice, e.g. `af_heart`, `am_michael`, `bf_emma`; list them with `docker compose exec studio python -c "import httpx;print(httpx.get('http://kokoro:8880/v1/audio/voices').text)"` |
| `music` | Background music from `assets/music/` (use the YouTube Audio Library) |
| `publish_mode` | `manual` (Telegram upload pack) or `api` (auto-upload) |
| `require_approval` | `true` means you tap Publish/Redo/Reject before anything goes live |
| `trends_geo`, `region`, `youtube_category_id` | Trend country, upload region, category (`28` = Science & Technology, `27` = Education) |

**Posting time:** change the cron in the first node. `0 9 * * *` means 9 AM daily; `0 9,18 * * *` means 9 AM and 6 PM.

**Long-form as well:** duplicate workflow 1, set `video_format` to `long`, and use a weekly schedule such as `0 10 * * 6` (Saturdays at 10 AM).

---

## 5. Switching to fully automatic publishing

1. In the Google Cloud project, go to **OAuth consent screen**, choose **External**, add yourself, then click **Publish app**.
   - If you leave the app in "Testing", Google expires your login every 7 days and uploads stop.
2. Create an **OAuth client ID** (Web application) with this redirect URI: `https://YOUR_DOMAIN/rest/oauth2-credential/callback`.
3. In n8n, add a **YouTube OAuth2 API** credential with that client ID and secret, and connect your channel.
4. Submit Google's **YouTube API Services - Audit and Quota Extension Form**, describing it as a personal tool that uploads to your own channel. This usually takes days to weeks.
5. Once approved, set `publish_mode` to `api`. Keep `require_approval = true` unless you trust the output completely.

Upload limits are not a concern: since June 2026, uploads have their own quota of 100 per day.

---

## 6. Monitoring

- **Telegram:**
  - every new video (preview or upload pack),
  - every publish,
  - an alert for every failure, with a link to the failed run,
  - a daily report with the biggest gainers, the best videos and the pipeline status.
- **Dashboard:** `https://YOUR_DOMAIN/dashboard?token=YOUR_TOKEN` shows every video, its status, views, likes and comments. It works well on a phone.
- **n8n → Executions:** every run step by step. Logs are pruned after 14 days to save disk space.
- **Server commands:**
  ```bash
  docker compose logs -f studio      # rendering
  docker compose logs -f n8n         # workflows
  docker compose --profile server pull && docker compose --profile server up -d --build    # update everything
  ```
- **Backup** (weekly):
  ```bash
  docker run --rm -v yt-autopilot_n8n_data:/d -v $PWD:/b alpine tar czf /b/n8n-$(date +%F).tgz -C /d .
  docker run --rm -v yt-autopilot_studio_data:/d -v $PWD:/b alpine tar czf /b/studio-$(date +%F).tgz -C /d studio.db
  ```

---

## 7. The money strategy

### Niche
Choose something you genuinely know, where viewers have money or careers at stake: cloud, DevOps, AI tools, programming, tech careers. Two reasons:
- **Pay per view:** English-language tech and education content usually earns far more per view than entertainment.
- **Monetization review:** your expertise is what makes the channel "authentic" in YouTube's eyes.

### Publishing rhythm
- **One Short a day:** brings discovery and subscribers (Shorts pay little per view but grow the channel fast).
- **One or two long videos a week:** this is where watch hours and real ad revenue come from.
- Turn your best-performing Short into a long video. The daily report shows you which ones those are.

### Earn before you're in the Partner Program
1. **Affiliate links** in descriptions and the pinned comment: cloud hosting, courses, tools you actually use. You can do this from day one.
2. **Your own digital product:** for example interview prep notes, cheat sheets or project templates, sold through Gumroad or Topmate. Mention it in every video.
3. **1:1 mentoring or consulting:** a few viewers will pay for direct help.
4. **Fan funding** (memberships, Super Thanks) opens at 500 subscribers; **brand sponsorships** typically start coming at around 5–10k engaged subscribers.

### Growth habits
- **The first 2 seconds decide everything.** The script prompt forces a strong hook. If a video underperforms, tap 🔁 Redo rather than publishing it.
- **Pin the suggested comment.** Replies early on help the algorithm push the video.
- **Group videos into playlists by topic.** People then watch several in a row, which adds up watch time.
- **Check YouTube Studio once a week.**
  - Click-through rate low? Rewrite titles and thumbnail text.
  - Average view duration low? Make the hooks stronger and the scripts shorter.
- **Feed the winners.** The system already does this: the AI gets your top 5 videos every day and makes more like them.

### 90-day plan
| Weeks | Do this |
|---|---|
| 1–2 | Set up the system. Publish 10 reviewed Shorts. Submit the API audit. Polish `creator_notes`. |
| 3–8 | One Short a day plus one long video a week. Add an affiliate link and a free lead magnet (e.g. a PDF checklist). |
| 9–12 | Double down on your top 3 topics, launch a paid product, and turn on auto-publishing once the audit is approved. |

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Video uploaded but private | Your API project isn't audited yet. Use `manual` mode (section 5). |
| `AI did not return JSON` | It retries automatically. If it keeps failing, switch to a stronger model in Config. |
| `AI picked a topic we already covered` | It will be fine on the next run; it's a guard against repeats. |
| Render times out or the server is slow | Use `short` format, or a server with more CPU. Only one video renders at a time. |
| Approval links don't open | Check that the domain resolves, HTTPS works and `WEBHOOK_URL` is set (it's in docker-compose). Run `docker compose logs caddy`. |
| Thumbnail not set | Custom thumbnails need a phone-verified channel (YouTube Studio → Settings → Channel → Feature eligibility). The video still publishes. |
| YouTube login breaks weekly | Your OAuth app is still in "Testing". Publish it (section 5, step 1). |
| Google Trends empty | Normal on some days. The AI picks a strong evergreen topic instead. |
| Daily report misses a video | Titles in YouTube must match what the system generated (it matches by title for manual uploads). |

---

## 9. Files

```
docker-compose.yml   4 services: caddy, n8n, kokoro, studio
docker-compose.local.yml   PC overrides (ports, local URLs)
start-local.ps1      Windows: starts kokoro + studio in Docker Desktop
import-workflows.bat Windows: imports workflows into D:\n8n
Caddyfile            HTTPS + routes
.env.example         settings and secrets
studio/              video renderer + stats store + dashboard (Python, FastAPI, ffmpeg)
assets/music/        optional background tracks
workflows/autopilot/
  1-create-and-publish.json   trends → topic → script → render → review → publish
  2-daily-stats-report.json   pulls YouTube stats, updates history, Telegram report
  3-error-alerts.json         any failure → Telegram
workflows/00-05-*.json        MiniMax AI-video pipeline (section 10)
docs/                         MiniMax pipeline setup, design and verification notes
tests/ tools/ scripts/        offline tests and generators for the MiniMax workflows
dist/                         MiniMax workflows as one importable ZIP
```

Stock footage comes from Pexels / Pixabay; a credit line is added to every description automatically.

---

## 10. Optional: MiniMax AI-video pipeline (Shorts + Reels)

A second, paid pipeline lives in `workflows/00-*.json` to `workflows/05-*.json`. It is independent of the Autopilot workflows above: it uses PostgreSQL, OpenAI and Shotstack (MiniMax video + ElevenLabs narration) instead of the studio/Kokoro/stock-footage stack. Both sets can live in the same n8n; all MiniMax workflows arrive inactive.

> **Telegram:** workflow 02 uses a Telegram Trigger, which takes over the bot's webhook. Keep only one Telegram Trigger per bot - use a separate bot for this pipeline if anything else listens to the same bot.

Run its offline tests with `node --test tests/` and `python -m unittest discover tests`.

Standalone n8n workflows that research a topic, generate **one MiniMax video**, send it to Telegram, and publish **that same file** to YouTube Shorts and Instagram Reels only after your approval. No separate application/backend service is required.

**[Download the workflow ZIP](dist/YT-Agent-n8n-workflows.zip)** · **[Setup and upgrade guide](docs/n8n-setup.md)**

All six workflows arrive inactive. Account credentials, niche, language, sources and voice still need configuration. No paid generation, Telegram delivery or social post was performed during development.

### Defaults designed to control spending

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

### Workflows

| File | Responsibility |
| --- | --- |
| [00 — Database](workflows/00-database-setup.json) | Create/update shared job, media, approval and budget state without deleting records. |
| [01 — Production](workflows/01-production.json) | Research permitted sources and write one timed storyboard for both platforms. |
| [04 — Render and review](workflows/04-render-and-review.json) | Quote every shot/narration, reserve budget, generate one video and send Telegram review. |
| [02 — Approval](workflows/02-telegram-approval.json) | Accept the exact Approve/Reject button only from your authorized Telegram users. |
| [03 — Publisher](workflows/03-publisher.json) | Verify approved hashes/accounts and upload the shared video to each platform. |
| [05 — Feedback](workflows/05-analytics-feedback.json) | Collect recent post metrics for later topic selection. |

Required accounts: n8n, PostgreSQL, OpenAI, Shotstack, Telegram, YouTube OAuth and Instagram professional publishing access. MiniMax generation uses your existing Shotstack key; no separate MiniMax credential is required. Target n8n version: **2.48.6**.

### Cost and profitability

A 30-second video is approximately **12 credits / US$2.40 / ₹230 before tax**, using current MiniMax 768p rates, about 400 narration characters and ₹95/USD for planning. At one video daily, allow roughly **₹11,000–₹14,000/month** including modest hosting, tax/FX and operating headroom. The default 500-credit monthly reservation cap represents about US$100 of PAYG credits before tax, not a subscription requirement. Actual charges depend on live quotes and account pricing. [Provider rates](https://help.shotstack.io/en/articles/17312748-understanding-shotstack-credit-consumption), [credit pricing](https://shotstack.io/pricing/)

The workflow obtains quotes before generation and reserves their sum plus rendering and a 25% margin. These are application budget guards, not provider billing guarantees. Failed/rejected generations can still cost money. Reservations are retained after failures and ambiguous outcomes; automatic regeneration is off. Set provider-side spending controls too.

Profitability depends on your revenue. Measure actual cost and earnings per accepted video before increasing duration or frequency. This workflow does not guarantee monetization, views or revenue.

### Upgrade and verification

For an existing installation, disable schedules, back up the database, import the updated exports and rerun **00** once to add the shared-media field and monthly-budget table. Reapply credentials and configuration, then create a fresh job. Keep only one Telegram Trigger for the bot. Do not reset old render/publication checkpoints. See the [complete upgrade procedure](docs/n8n-setup.md).

Offline tests exercise shared-file reuse, only one generation reservation, India daily/monthly limits, one-preview/two-destination approval, replay/hash checks and publication state. See [verification details](docs/verification.md). **Live n8n import, provider generation quality and account publishing remain unverified.**

Shots may vary in subject consistency; narration is continuous rather than guaranteed lip-sync. Files must fit the complete 45 MB Telegram review. This version focuses on shared Shorts/Reels; separate long-form videos, images, comment replies, livestreams and customer account isolation are not included.
