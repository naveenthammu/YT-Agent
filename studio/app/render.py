"""Video renderer: script segments -> narrated, captioned MP4 + thumbnail.

Pipeline per job:
  1. Text-to-speech for every segment (Kokoro, OpenAI-compatible endpoint)
  2. Stock b-roll for every segment (Pexels and/or Pixabay), cut into short shots
  3. Word-chunk captions (ASS) timed to the narration
  4. Final mix: b-roll + captions + narration (+ optional background music)
  5. Thumbnail: frame from the video + big outlined headline
"""
from __future__ import annotations

import logging
import os
import random
import re
import shutil
import subprocess
import textwrap
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

log = logging.getLogger("studio.render")

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
MEDIA_DIR = DATA_DIR / "media"
WORK_DIR = DATA_DIR / "work"
MUSIC_DIR = Path(os.getenv("MUSIC_DIR", "/assets/music"))
KOKORO_URL = os.getenv("KOKORO_URL", "http://kokoro:8880").rstrip("/")
PEXELS_API_KEY = os.getenv("PEXELS_API_KEY", "")
PIXABAY_API_KEY = os.getenv("PIXABAY_API_KEY", "")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
INTERNAL_BASE_URL = os.getenv("INTERNAL_BASE_URL", "http://studio:8000").rstrip("/")
FONT_FILE = os.getenv("FONT_FILE", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
FONT_NAME = os.getenv("FONT_NAME", "DejaVu Sans")
MEDIA_RETENTION_DAYS = float(os.getenv("MEDIA_RETENTION_DAYS", "7"))
FALLBACK_QUERY = os.getenv("FALLBACK_QUERY", "abstract technology background")

FPS = 30
SIZES = {"short": (1080, 1920), "long": (1920, 1080)}
MAX_SHOT = {"short": 3.5, "long": 6.0}       # seconds per b-roll shot (pacing)
CAPTION_WORDS = {"short": 3, "long": 7}      # words per caption chunk
SEGMENT_PAD = 0.25                           # silence after each segment (s)


class RenderError(RuntimeError):
    pass


# --------------------------------------------------------------------------- utils
def run(cmd: list[str], cwd: Path | None = None) -> None:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise RenderError(f"ffmpeg failed: {' '.join(cmd[:6])}...\n{tail}")


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError as exc:
        raise RenderError(f"Could not read duration of {path.name}") from exc


def cleanup_old_media() -> None:
    cutoff = time.time() - MEDIA_RETENTION_DAYS * 86400
    for f in MEDIA_DIR.glob("*"):
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink(missing_ok=True)


# --------------------------------------------------------------------------- TTS
def synthesize(text: str, voice: str, speed: float, out_wav: Path) -> float:
    """Kokoro TTS -> normalised 48 kHz stereo WAV with a short tail pause."""
    raw = out_wav.with_suffix(".raw.wav")
    for attempt in range(3):
        try:
            r = httpx.post(
                f"{KOKORO_URL}/v1/audio/speech",
                json={"model": "kokoro", "input": text, "voice": voice,
                      "response_format": "wav", "speed": speed},
                timeout=300,
            )
            r.raise_for_status()
            raw.write_bytes(r.content)
            break
        except httpx.HTTPError as exc:
            if attempt == 2:
                raise RenderError(f"TTS failed: {exc}") from exc
            time.sleep(3 * (attempt + 1))
    run(["ffmpeg", "-y", "-i", str(raw), "-af", f"apad=pad_dur={SEGMENT_PAD}",
         "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(out_wav)])
    raw.unlink(missing_ok=True)
    return probe_duration(out_wav)


# --------------------------------------------------------------------------- stock footage
@dataclass
class Clip:
    id: str          # "px-123" (Pexels) or "pb-456" (Pixabay)
    url: str
    duration: float


class StockFinder:
    """Free stock video search (Pexels first, then Pixabay) with per-job caching
    and shot de-duplication. Works with either key, or both."""

    PEXELS_ENDPOINTS = ("https://api.pexels.com/v1/videos/search",
                        "https://api.pexels.com/videos/search")
    PIXABAY_ENDPOINT = "https://pixabay.com/api/videos/"

    def __init__(self, fmt: str):
        self.fmt = fmt
        self.target_w, self.target_h = SIZES[fmt]
        self.orientation = "portrait" if fmt == "short" else "landscape"
        self.cache: dict[str, list[Clip]] = {}
        self.used: set[str] = set()
        self.client = httpx.Client(timeout=60, follow_redirects=True)

    def _pick_pexels_file(self, files: list[dict]) -> str | None:
        mp4s = [f for f in files if f.get("file_type") == "video/mp4" and f.get("link")]
        if not mp4s:
            return None
        short_side = min(self.target_w, self.target_h)
        good = [f for f in mp4s if min(f.get("width") or 0, f.get("height") or 0) >= 720]
        pool = good or mp4s
        # smallest file that still covers the target -> fast downloads
        return min(pool, key=lambda f: abs(min(f.get("width") or 0, f.get("height") or 0) - short_side))["link"]

    def _search_pexels(self, query: str) -> list[Clip]:
        clips: list[Clip] = []
        params = {"query": query, "orientation": self.orientation, "per_page": 15, "size": "medium"}
        for url in self.PEXELS_ENDPOINTS:
            try:
                r = self.client.get(url, params=params, headers={"Authorization": PEXELS_API_KEY})
                if r.status_code == 404:
                    continue
                r.raise_for_status()
                for v in r.json().get("videos", []):
                    link = self._pick_pexels_file(v.get("video_files", []))
                    if link and (v.get("duration") or 0) >= 2:
                        clips.append(Clip(f"px-{v['id']}", link, float(v["duration"])))
                break
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("Pexels search failed for %r: %s", query, exc)
                break
        return clips

    def _search_pixabay(self, query: str) -> list[Clip]:
        clips: list[Clip] = []
        try:
            r = self.client.get(self.PIXABAY_ENDPOINT, params={
                "key": PIXABAY_API_KEY, "q": query[:100], "per_page": 20,
                "safesearch": "true", "video_type": "film"})
            r.raise_for_status()
            for h in r.json().get("hits", []):
                vids = h.get("videos") or {}
                # 1080p "medium" is the sweet spot; fall back to other sizes
                for size in ("medium", "large", "small"):
                    f = vids.get(size) or {}
                    if f.get("url") and min(f.get("width") or 0, f.get("height") or 0) >= 540:
                        if (h.get("duration") or 0) >= 2:
                            clips.append(Clip(f"pb-{h['id']}", f["url"], float(h["duration"])))
                        break
            # prefer clips already in the right orientation
            if clips and self.orientation == "portrait":
                portrait = {f"pb-{h['id']}" for h in r.json().get("hits", [])
                            if (h.get("videos", {}).get("medium", {}).get("height") or 0)
                            > (h.get("videos", {}).get("medium", {}).get("width") or 0)}
                clips.sort(key=lambda c: c.id not in portrait)
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Pixabay search failed for %r: %s", query, exc)
        return clips

    def search(self, query: str) -> list[Clip]:
        query = query.strip()[:80] or FALLBACK_QUERY
        if query in self.cache:
            return self.cache[query]
        clips: list[Clip] = []
        if PEXELS_API_KEY:
            clips = self._search_pexels(query)
        if len(clips) < 3 and PIXABAY_API_KEY:
            clips += self._search_pixabay(query)
        if not PEXELS_API_KEY and not PIXABAY_API_KEY:
            log.warning("No PEXELS_API_KEY or PIXABAY_API_KEY set - videos will use a plain background")
        self.cache[query] = clips
        return clips

    def candidates(self, query: str) -> list[Clip]:
        words = re.findall(r"[A-Za-z0-9]+", query)
        tries = [query, " ".join(words[:2]), FALLBACK_QUERY]
        seen: set[str] = set()
        out: list[Clip] = []
        for q in tries:
            for c in self.search(q):
                if c.id not in seen:
                    seen.add(c.id)
                    out.append(c)
            if len([c for c in out if c.id not in self.used]) >= 3:
                break
        fresh = [c for c in out if c.id not in self.used]
        return fresh + [c for c in out if c.id in self.used]   # reuse only as last resort

    def download(self, clip: Clip, dest: Path) -> Path:
        if dest.exists():
            return dest
        with self.client.stream("GET", clip.url) as r:
            r.raise_for_status()
            with dest.open("wb") as fh:
                for chunk in r.iter_bytes(1 << 16):
                    fh.write(chunk)
        return dest

    def close(self) -> None:
        self.client.close()


def encode_shot(src: Path | None, start: float, length: float, size: tuple[int, int], out: Path) -> None:
    w, h = size
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={FPS},setsar=1,format=yuv420p"
    common = ["-t", f"{length:.3f}", "-an", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast",
              "-crf", "20", "-r", str(FPS), str(out)]
    if src is None:  # no footage available -> calm dark background
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=0x0f172a:s={w}x{h}:r={FPS}"] + common)
    else:
        run(["ffmpeg", "-y", "-ss", f"{start:.3f}", "-stream_loop", "-1", "-i", str(src)] + common)


def build_segment_visual(idx: int, query: str, duration: float, fmt: str,
                         finder: StockFinder, work: Path) -> list[Path]:
    size = SIZES[fmt]
    shots: list[Path] = []
    remaining = duration
    sources: list[tuple[Path, Clip]] = []
    for clip in finder.candidates(query):
        if remaining <= 0.05:
            break
        try:
            path = finder.download(clip, work / f"src_{clip.id}.mp4")
        except httpx.HTTPError as exc:
            log.warning("Download failed for clip %s: %s", clip.id, exc)
            continue
        finder.used.add(clip.id)
        sources.append((path, clip))
        take = min(remaining, MAX_SHOT[fmt])
        start = random.uniform(0, max(0.0, clip.duration - take - 0.5))
        out = work / f"shot_{idx:03d}_{len(shots):02d}.mp4"
        encode_shot(path, start, take, size, out)
        shots.append(out)
        remaining -= take
    # Not enough distinct clips: cycle what we have, or fall back to a plain background
    cycle = 0
    while remaining > 0.05:
        take = min(remaining, MAX_SHOT[fmt])
        out = work / f"shot_{idx:03d}_{len(shots):02d}.mp4"
        if sources:
            path, clip = sources[cycle % len(sources)]
            start = random.uniform(0, max(0.0, clip.duration - take - 0.5))
            encode_shot(path, start, take, size, out)
        else:
            encode_shot(None, 0, take, size, out)
        shots.append(out)
        remaining -= take
        cycle += 1
    return shots


# --------------------------------------------------------------------------- captions
def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def write_captions(segments: list[dict], timings: list[tuple[float, float]], fmt: str, path: Path) -> None:
    w, h = SIZES[fmt]
    size = 82 if fmt == "short" else 58
    margin_v = 560 if fmt == "short" else 80
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Main,{FONT_NAME},{size},&H00FFFFFF,&H0000D4FF,&H00000000,&H96000000,"
        f"-1,0,0,0,100,100,0,0,1,6,2,2,80,80,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    n = CAPTION_WORDS[fmt]
    for seg, (start, dur) in zip(segments, timings):
        words = seg["text"].split()
        if not words:
            continue
        chunks = [" ".join(words[i:i + n]) for i in range(0, len(words), n)]
        speech = max(0.3, dur - SEGMENT_PAD)
        total_chars = sum(len(c) for c in chunks) or 1
        t = start
        for i, chunk in enumerate(chunks):
            d = speech * len(chunk) / total_chars
            text = chunk.upper() if fmt == "short" else chunk
            # alternate highlight colour on every other chunk for shorts
            if fmt == "short" and i % 2 == 1:
                text = r"{\c&H0000D4FF&}" + _ass_escape(text)
            else:
                text = _ass_escape(text)
            lines.append(f"Dialogue: 0,{_ass_time(t)},{_ass_time(t + d)},Main,,0,0,0,,{text}")
            t += d
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- thumbnail
def _fit_font(draw: ImageDraw.ImageDraw, text: str, max_w: int, max_h: int) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    for size in range(150, 40, -6):
        font = ImageFont.truetype(FONT_FILE, size)
        for width in (10, 14, 18, 24):
            wrapped = textwrap.wrap(text, width=width)
            if len(wrapped) > 3:
                continue
            boxes = [draw.textbbox((0, 0), ln, font=font, stroke_width=10) for ln in wrapped]
            tw = max(b[2] - b[0] for b in boxes)
            th = sum(b[3] - b[1] for b in boxes) + 20 * (len(wrapped) - 1)
            if tw <= max_w and th <= max_h:
                return font, wrapped
    font = ImageFont.truetype(FONT_FILE, 44)
    return font, textwrap.wrap(text, width=28)[:3]


def make_thumbnail(frame: Path, text: str, out: Path) -> None:
    W, H = 1280, 720
    img = Image.open(frame).convert("RGB")
    scale = max(W / img.width, H / img.height)
    img = img.resize((int(img.width * scale) + 1, int(img.height * scale) + 1))
    left = (img.width - W) // 2
    top = (img.height - H) // 2
    img = img.crop((left, top, left + W, top + H))

    # darken toward the bottom-left so the text pops
    shade = Image.new("L", (W, H))
    sd = ImageDraw.Draw(shade)
    for y in range(H):
        sd.line([(0, y), (W, y)], fill=int(60 + 140 * (y / H)))
    img = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), img, shade)

    text = (text or "").strip().upper() or "WATCH THIS"
    draw = ImageDraw.Draw(img)
    font, lines = _fit_font(draw, text, W - 120, H - 160)
    heights = [draw.textbbox((0, 0), ln, font=font, stroke_width=10) for ln in lines]
    total_h = sum(b[3] - b[1] for b in heights) + 20 * (len(lines) - 1)
    y = H - 70 - total_h
    for i, (ln, b) in enumerate(zip(lines, heights)):
        fill = (255, 212, 0) if i == 0 else (255, 255, 255)
        draw.text((60, y - b[1]), ln, font=font, fill=fill, stroke_width=10, stroke_fill=(0, 0, 0))
        y += (b[3] - b[1]) + 20
    img.save(out, "JPEG", quality=88, optimize=True)


# --------------------------------------------------------------------------- music
def pick_music() -> Path | None:
    if not MUSIC_DIR.is_dir():
        return None
    tracks = [p for p in MUSIC_DIR.iterdir() if p.suffix.lower() in {".mp3", ".wav", ".m4a", ".ogg"}]
    return random.choice(tracks) if tracks else None


# --------------------------------------------------------------------------- main entry
def render(job: dict) -> dict:
    """job = {format, voice, speed, thumbnail_text, segments:[{text, visual_query}], music}"""
    fmt = job.get("format", "short")
    if fmt not in SIZES:
        raise RenderError("format must be 'short' or 'long'")
    segments = [s for s in job.get("segments", []) if s.get("text", "").strip()]
    if not segments:
        raise RenderError("No segments with text")

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_old_media()

    job_id = uuid.uuid4().hex
    work = WORK_DIR / job_id
    work.mkdir(parents=True)
    t0 = time.time()
    finder = StockFinder(fmt)
    try:
        # 1. narration
        timings: list[tuple[float, float]] = []
        wavs: list[Path] = []
        clock = 0.0
        for i, seg in enumerate(segments):
            wav = work / f"voice_{i:03d}.wav"
            dur = synthesize(seg["text"].strip(), job.get("voice", "af_heart"),
                             float(job.get("speed", 1.0)), wav)
            wavs.append(wav)
            timings.append((clock, dur))
            clock += dur
        total = clock
        (work / "audio.txt").write_text("".join(f"file '{w.name}'\n" for w in wavs))
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "audio.txt",
             "-c", "copy", "narration.wav"], cwd=work)

        # 2. b-roll
        shots: list[Path] = []
        for i, (seg, (_, dur)) in enumerate(zip(segments, timings)):
            query = seg.get("visual_query") or seg["text"][:60]
            shots += build_segment_visual(i, query, dur, fmt, finder, work)
        (work / "video.txt").write_text("".join(f"file '{s.name}'\n" for s in shots))
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "video.txt",
             "-c", "copy", "broll.mp4"], cwd=work)

        # 3. captions
        write_captions(segments, timings, fmt, work / "captions.ass")

        # 4. final mix
        out_name = f"{job_id}.mp4"
        out_path = MEDIA_DIR / out_name
        music = pick_music() if job.get("music", True) else None
        cmd = ["ffmpeg", "-y", "-i", "broll.mp4", "-i", "narration.wav"]
        vchain = "[0:v]tpad=stop_mode=clone:stop_duration=2,subtitles=captions.ass[v]"
        achain = "[1:a]loudnorm=I=-14:TP=-1.5:LRA=11[voice]"
        if music:
            cmd += ["-stream_loop", "-1", "-i", str(music)]
            achain += (";[2:a]aresample=48000,volume=0.07[bg];"
                       "[voice][bg]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]")
        else:
            achain += ";[voice]anull[a]"
        cmd += ["-filter_complex", f"{vchain};{achain}", "-map", "[v]", "-map", "[a]",
                "-t", f"{total:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                "-pix_fmt", "yuv420p", "-r", str(FPS), "-c:a", "aac", "-b:a", "160k",
                "-ar", "48000", "-movflags", "+faststart", str(out_path)]
        run(cmd, cwd=work)

        # 5. thumbnail
        frame = work / "frame.jpg"
        run(["ffmpeg", "-y", "-ss", f"{min(1.5, total / 3):.2f}", "-i", "broll.mp4",
             "-frames:v", "1", "-q:v", "2", "frame.jpg"], cwd=work)
        thumb_name = f"{job_id}.jpg"
        make_thumbnail(frame, job.get("thumbnail_text") or job.get("title", ""), MEDIA_DIR / thumb_name)

        size_mb = round(out_path.stat().st_size / 1_048_576, 2)
        return {
            "id": job_id,
            "format": fmt,
            "duration_sec": round(probe_duration(out_path), 2),
            "size_mb": size_mb,
            "segments": len(segments),
            "render_seconds": round(time.time() - t0, 1),
            "video_file": out_name,
            "thumb_file": thumb_name,
            "internal_video_url": f"{INTERNAL_BASE_URL}/media/{out_name}",
            "internal_thumb_url": f"{INTERNAL_BASE_URL}/media/{thumb_name}",
            "public_video_url": f"{PUBLIC_BASE_URL}/media/{out_name}" if PUBLIC_BASE_URL else "",
            "public_thumb_url": f"{PUBLIC_BASE_URL}/media/{thumb_name}" if PUBLIC_BASE_URL else "",
            "stock_credit": "Stock footage: Pexels / Pixabay",
        }
    finally:
        finder.close()
        if os.getenv("KEEP_WORK") != "1":
            shutil.rmtree(work, ignore_errors=True)
