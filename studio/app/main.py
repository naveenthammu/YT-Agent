"""Studio API - used by n8n over the private Docker network.

Public (through Caddy):   /media/*  (finished videos/thumbnails)   /dashboard?token=...
Private (n8n only):       /render  /videos  /videos/stats  /health
"""
from __future__ import annotations

import html
import logging
import os
import threading
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, render

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("studio")

DASHBOARD_TOKEN = os.getenv("DASHBOARD_TOKEN", "")
_render_lock = threading.Lock()   # one render at a time keeps a small VPS stable

render.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
db.init()

app = FastAPI(title="YT Autopilot Studio", version="1.0")
app.mount("/media", StaticFiles(directory=render.MEDIA_DIR), name="media")


class Segment(BaseModel):
    text: str = Field(..., min_length=1, max_length=1200)
    visual_query: str = Field("", max_length=120)


class RenderRequest(BaseModel):
    format: Literal["short", "long"] = "short"
    voice: str = "af_heart"
    speed: float = Field(1.0, ge=0.6, le=1.5)
    title: str = ""
    thumbnail_text: str = ""
    music: bool = True
    segments: list[Segment] = Field(..., min_length=1, max_length=60)


class StatsRequest(BaseModel):
    updates: list[dict]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "busy": _render_lock.locked()}


@app.post("/render")
def do_render(req: RenderRequest) -> dict:
    with _render_lock:
        log.info("Render start: %s, %d segments", req.format, len(req.segments))
        try:
            result = render.render(req.model_dump())
        except render.RenderError as exc:
            log.error("Render failed: %s", exc)
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        log.info("Render done: %s (%.1fs video, %.1fs work)", result["id"],
                 result["duration_sec"], result["render_seconds"])
        return result


@app.post("/videos")
def upsert_video(data: dict) -> dict:
    try:
        return db.upsert(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/videos")
def list_videos(days: int = Query(120, ge=1, le=3650)) -> dict:
    # wrapped in an object so n8n receives ONE item, not one item per row
    return {"videos": db.list_recent(days)}


@app.post("/videos/stats")
def update_stats(req: StatsRequest) -> dict:
    return {"updated": db.update_stats(req.updates)}


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard(token: str = "", days: int = 90) -> str:
    if DASHBOARD_TOKEN and token != DASHBOARD_TOKEN:
        raise HTTPException(status_code=401, detail="Add ?token=YOUR_DASHBOARD_TOKEN to the URL")
    rows = db.list_recent(days)
    published = [r for r in rows if r.get("youtube_id")]
    total_views = sum(r.get("views") or 0 for r in rows)
    best = max(rows, key=lambda r: r.get("views") or 0, default=None)
    status_count: dict[str, int] = {}
    for r in rows:
        status_count[r.get("status") or "?"] = status_count.get(r.get("status") or "?", 0) + 1

    def cell(r: dict) -> str:
        title = html.escape(r.get("title") or r.get("topic") or "(untitled)")
        if r.get("youtube_id"):
            title = f'<a href="https://youtu.be/{html.escape(r["youtube_id"])}">{title}</a>'
        elif r.get("video_url"):
            title = f'<a href="{html.escape(r["video_url"])}">{title}</a>'
        return (f"<tr><td>{(r.get('created_at') or '')[:10]}</td><td>{title}</td>"
                f"<td>{html.escape(r.get('format') or '')}</td>"
                f"<td><span class='s {html.escape(r.get('status') or '')}'>{html.escape(r.get('status') or '')}</span></td>"
                f"<td class='n'>{r.get('views') or 0:,}</td><td class='n'>{r.get('likes') or 0:,}</td>"
                f"<td class='n'>{r.get('comments') or 0:,}</td></tr>")

    chips = "".join(f"<span class='chip'>{html.escape(k)}: {v}</span>" for k, v in sorted(status_count.items()))
    best_html = (f"{html.escape(best.get('title') or '')} &middot; {best.get('views') or 0:,} views"
                 if best and (best.get('views') or 0) > 0 else "&mdash;")
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>YT Autopilot</title>
<style>
body{{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#0b1220;color:#e5e7eb}}
h1{{font-size:20px;margin:0 0 12px}} a{{color:#7dd3fc}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}}
.card{{background:#111a2e;border-radius:10px;padding:12px}} .card b{{display:block;font-size:22px}}
.chip{{display:inline-block;background:#1f2a44;border-radius:12px;padding:3px 10px;margin:0 6px 6px 0;font-size:13px}}
table{{width:100%;border-collapse:collapse;font-size:14px}} td,th{{padding:8px;border-bottom:1px solid #1f2a44;text-align:left}}
.n{{text-align:right}} .s{{font-size:12px;padding:2px 8px;border-radius:8px;background:#334155}}
.published{{background:#14532d}} .rejected,.failed{{background:#7f1d1d}} .ready_manual{{background:#78350f}}
.wrap{{overflow-x:auto}}
</style></head><body>
<h1>YT Autopilot &mdash; last {days} days</h1>
<div class="cards">
<div class="card">Videos made<b>{len(rows)}</b></div>
<div class="card">On YouTube<b>{len(published)}</b></div>
<div class="card">Total views<b>{total_views:,}</b></div>
<div class="card">Best video<b style="font-size:14px">{best_html}</b></div>
</div>
<div>{chips}</div>
<div class="wrap"><table><tr><th>Date</th><th>Title</th><th>Fmt</th><th>Status</th><th class="n">Views</th><th class="n">Likes</th><th class="n">Cmts</th></tr>
{''.join(cell(r) for r in rows) or '<tr><td colspan=7>No videos yet.</td></tr>'}
</table></div></body></html>"""
