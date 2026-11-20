# MiniMax shared-video design — 20 November 2026

The user requested a lower-cost MiniMax pipeline, one daily video reused on YouTube and Instagram, Telegram approval, and a push to main. The previous Seedance pipeline generated separate destination videos. The new design retains the existing approval/publication records and gives the Instagram asset a source_asset_id referencing one canonical YouTube video.

Alternatives considered: a new publications-target schema would require a larger approval/publisher migration; relying on provider cache reuse would not guarantee one billable generation. A canonical media asset with a destination alias guarantees that only one row enters generation while preserving the established two-publication state machine.

The default 30-second portrait video reduces cost from the earlier 45-second assumption. MiniMax H3 uses 5..15-second shots at 768p, then renders one 720×1280 video with separate narration. Exact model parameters and live quote schemas were checked against official Shotstack sources. Every quote is counted once; native scene audio is muted and edit-only volume is removed from quote payloads.

Daily attempts and monthly reserved credits use India calendar boundaries. Budgets default 16 credits/job and 500/month, with a 25% quote margin; no automatic rerolls. Hourly render/publisher polling reduces idle n8n executions. This prioritizes predictable cost over immediate publication; manual ticks can advance an already generated/approved job without extra generation.

The master must pass file quality/size/hash checks before the alias can become ready. Telegram sends one file and both destinations' exact metadata. User approval is required before two independent uploads of those same bytes. The existing identity/replay/expiry/hash guards remain. Partial/uncertain platform outcomes do not cause duplicate generation or reposting.

Existing installations rerun 00 to add the nullable self-reference and monthly credit table without deleting data. Existing submitted jobs keep their saved render IDs. Old planned modes fail preflight and require a fresh job. No live generation or account publication was run during implementation.

Costs depend on actual quotes and output acceptance; profitability depends on revenue and is not guaranteed. See setup guide for configuration, defaults, cost assumptions and upgrade steps.

Sources: [MiniMax H3 options](https://shotstack.io/models/minimax-h3/), [generation quotes](https://shotstack.io/docs/api/#quote-generation), [current credit usage](https://help.shotstack.io/en/articles/17312748-understanding-shotstack-credit-consumption).
