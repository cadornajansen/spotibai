#!/usr/bin/env python3
"""Download an authorized TikTok video, transcribe it with AssemblyAI, and write LRC lyrics.

Install once:
    pip install -U yt-dlp assemblyai

This script also needs FFmpeg on your PATH because yt-dlp uses it to merge the
downloaded video and extract its audio track.

Usage:
    set ASSEMBLYAI_API_KEY=your_key_here
    python tiktok_to_lrc.py "https://www.tiktok.com/@creator/video/123456789"

Each run creates songs/<song-name>/ and updates src/data/spotify.json. Only
download and transcribe media that you own or are authorized to use.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import assemblyai as aai
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SONGS_DIR = PROJECT_ROOT / "songs"
DEFAULT_CATALOG_PATH = PROJECT_ROOT / "src" / "data" / "spotify.json"
AUDIO_EXTENSIONS = {".m4a", ".mp3", ".opus", ".aac", ".wav"}


@dataclass(frozen=True)
class TimedWord:
    """One transcript token with the timestamp AssemblyAI returns in milliseconds."""

    text: str
    start_ms: int


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download an authorized TikTok video and create timed LRC lyrics."
    )
    parser.add_argument("url", help="Public TikTok video URL to download.")
    parser.add_argument(
        "--songs-dir",
        type=Path,
        default=DEFAULT_SONGS_DIR,
        help=f"Folder where song media is saved (default: {DEFAULT_SONGS_DIR}).",
    )
    parser.add_argument(
        "--catalog-path",
        type=Path,
        default=DEFAULT_CATALOG_PATH,
        help=f"Editable catalogue JSON file (default: {DEFAULT_CATALOG_PATH}).",
    )
    parser.add_argument(
        "--language",
        help="Optional AssemblyAI language code, such as en_us. Omits language detection.",
    )
    parser.add_argument(
        "--max-line-length",
        type=int,
        default=42,
        help="Maximum characters per generated lyric line (default: 42).",
    )
    parser.add_argument(
        "--cookies",
        type=Path,
        help="Path to a cookies.txt file in Netscape format.",
    )
    parser.add_argument(
        "--cookies-from-browser",
        help="Browser name to extract cookies from (e.g. firefox, chrome, edge, brave).",
    )
    return parser.parse_args()


def validate_tiktok_url(url: str) -> None:
    hostname = (urlparse(url).hostname or "").lower()
    if hostname == "tiktok.com" or hostname.endswith(".tiktok.com"):
        return
    raise ValueError("Provide a TikTok URL, for example https://www.tiktok.com/@creator/video/123.")


def require_dependencies() -> str:
    api_key = os.environ.get("ASSEMBLYAI_API_KEY")
    if not api_key:
        env_file = PROJECT_ROOT / ".env"
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                if line.startswith("ASSEMBLYAI_API_KEY="):
                    api_key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not api_key:
        raise RuntimeError("ASSEMBLYAI_API_KEY is not set. Set it in your environment or .env, then run the script again.")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("FFmpeg was not found on PATH. Install FFmpeg, then run the script again.")
    return api_key


def song_folder_name(title: str, video_id: str) -> str:
    """Use a predictable, safe folder name such as songs/wait-a-minute/."""

    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name or f"song-{video_id}"


def build_ydl_cookie_opts(
    cookies: Path | None = None,
    cookies_from_browser: str | None = None,
) -> dict[str, Any]:
    opts: dict[str, Any] = {}
    if cookies:
        opts["cookiefile"] = str(cookies.resolve())
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    return opts


def fetch_metadata(url: str, cookie_opts: dict[str, Any] | None = None) -> dict[str, Any]:
    ydl_opts: dict[str, Any] = {"noplaylist": True, "quiet": True}
    if cookie_opts:
        ydl_opts.update(cookie_opts)
    with YoutubeDL(ydl_opts) as downloader:
        info = downloader.extract_info(url, download=False)
    if not isinstance(info, dict) or not info.get("id"):
        raise RuntimeError("yt-dlp did not return video metadata for this URL.")
    return info


def ensure_cover_image(song_dir: Path, video_path: Path, thumbnail_url: str | None = None) -> Path | None:
    cover_names = ("cover.jpg", "cover.png", "image.png")
    for name in cover_names:
        candidate = song_dir / name
        if candidate.exists() and candidate.stat().st_size > 0:
            return candidate

    cover_target = song_dir / "cover.jpg"
    if thumbnail_url:
        try:
            print("Downloading cover artwork…")
            req = urllib.request.Request(thumbnail_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp, open(cover_target, "wb") as f:
                shutil.copyfileobj(resp, f)
            if cover_target.exists() and cover_target.stat().st_size > 0:
                return cover_target
        except Exception as exc:
            print(f"Thumbnail download failed ({exc}), falling back to video frame extraction…")

    if video_path.exists():
        print("Extracting cover frame from video with ffmpeg…")
        cmd = [
            "ffmpeg", "-y",
            "-ss", "00:00:01.5",
            "-i", str(video_path),
            "-vframes", "1",
            "-q:v", "2",
            str(cover_target),
        ]
        res = subprocess.run(cmd, capture_output=True)
        if res.returncode != 0 or not cover_target.exists() or cover_target.stat().st_size == 0:
            cmd[2] = "00:00:00.5"
            subprocess.run(cmd, capture_output=True)

    if cover_target.exists() and cover_target.stat().st_size > 0:
        return cover_target
    return None


def download_media_fallback(url: str, songs_dir: Path) -> tuple[Path, Path, dict[str, Any], Path]:
    """Fallback extraction using public TikTok video stream when yt-dlp encounters cookie/auth blocks."""
    print("Extracting video stream via direct TikTok service…")
    api_url = f"https://www.tikwm.com/api/?url={url}"
    req = urllib.request.Request(
        api_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        api_data = json.loads(resp.read().decode("utf-8"))

    if api_data.get("code") != 0 or not api_data.get("data"):
        raise RuntimeError(f"Fallback TikTok API error: {api_data.get('msg') or 'Unknown error'}")

    d = api_data["data"]
    video_id = str(d.get("id") or "")
    raw_title = str(d.get("title") or video_id).strip()
    author = str(d.get("author", {}).get("nickname") or d.get("author", {}).get("unique_id") or "SpotiBai")
    video_url = d.get("play")
    cover_url = d.get("cover")
    duration = d.get("duration")

    clean_title = re.sub(r"[#@][\w]+", "", raw_title).strip()
    clean_title = re.sub(r"[^\w\s\-\.\,\'\(\)]", "", clean_title).strip()
    if not clean_title:
        clean_title = f"song-{video_id}"

    song_dir = songs_dir / song_folder_name(clean_title, video_id)
    song_dir.mkdir(parents=True, exist_ok=True)

    safe_name = re.sub(r'[\\/*?:"<>|]', "_", clean_title)[:80].strip()
    video_path = song_dir / f"{safe_name} [{video_id}].mp4"
    audio_path = song_dir / f"{safe_name} [{video_id}].m4a"

    print(f"Downloading MP4 stream to {video_path.name}…")
    v_req = urllib.request.Request(video_url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(v_req, timeout=90) as v_resp, open(video_path, "wb") as out_v:
        shutil.copyfileobj(v_resp, out_v)

    print(f"Extracting M4A audio to {audio_path.name}…")
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-c:a", "aac", "-b:a", "192k",
        str(audio_path),
    ]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extraction failed: {res.stderr.decode('utf-8', errors='ignore')}")

    ensure_cover_image(song_dir, video_path, cover_url)

    metadata = {
        "id": video_id,
        "title": clean_title,
        "uploader": author,
        "channel": author,
        "duration": duration,
        "thumbnail": cover_url or "",
    }
    return video_path, audio_path, metadata, song_dir


def download_media(
    url: str,
    songs_dir: Path,
    cookies: Path | None = None,
    cookies_from_browser: str | None = None,
) -> tuple[Path, Path, dict[str, Any], Path]:
    """Download the MP4 and extract an M4A into songs/<song-name>/."""
    cookie_opts = build_ydl_cookie_opts(cookies, cookies_from_browser)

    try:
        metadata = fetch_metadata(url, cookie_opts)
        video_id = str(metadata["id"])
        title = str(metadata.get("title") or video_id)
        song_dir = songs_dir / song_folder_name(title, video_id)
        song_dir.mkdir(parents=True, exist_ok=True)

        options: dict[str, Any] = {
            "format": "bv*+ba/b",
            "merge_output_format": "mp4",
            "outtmpl": str(song_dir / "%(title).80s [%(id)s].%(ext)s"),
            "noplaylist": True,
            "restrictfilenames": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "m4a",
                    "preferredquality": "192",
                }
            ],
            "keepvideo": True,
        }
        options.update(cookie_opts)

        with YoutubeDL(options) as downloader:
            metadata = downloader.extract_info(url, download=True)

        matching_files = sorted(
            (path for path in song_dir.iterdir() if video_id in path.name),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        video_path = next((path for path in matching_files if path.suffix.lower() == ".mp4"), None)
        audio_path = next((path for path in matching_files if path.suffix.lower() in AUDIO_EXTENSIONS), None)

        if video_path is None or audio_path is None:
            raise RuntimeError("The download completed, but the expected MP4 or M4A file was not created.")

        ensure_cover_image(song_dir, video_path, metadata.get("thumbnail"))
        return video_path, audio_path, metadata, song_dir
    except Exception as exc:
        print(f"yt-dlp extraction note: {exc}")
        print("Switching to direct stream fallback…")
        return download_media_fallback(url, songs_dir)


def transcribe_audio(audio_path: Path, language: str | None, api_key: str) -> list[TimedWord]:
    """Upload audio to AssemblyAI and return timestamped transcript words."""

    aai.settings.api_key = api_key
    config = (
        aai.TranscriptionConfig(language_code=language)
        if language
        else aai.TranscriptionConfig(language_detection=True)
    )
    transcript = aai.Transcriber().transcribe(str(audio_path), config=config)

    if transcript.status == aai.TranscriptStatus.error:
        raise RuntimeError(f"AssemblyAI transcription failed: {transcript.error}")

    words = getattr(transcript, "words", None)
    if not words:
        raise RuntimeError("AssemblyAI returned no timed words, so an LRC file could not be created.")

    return [
        TimedWord(text=word.text.strip(), start_ms=int(word.start))
        for word in words
        if word.text and word.text.strip() and word.start is not None
    ]


def to_lrc_timestamp(milliseconds: int) -> str:
    total_centiseconds = max(milliseconds, 0) // 10
    minutes, centiseconds = divmod(total_centiseconds, 6_000)
    seconds, centiseconds = divmod(centiseconds, 100)
    return f"{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def group_words(words: list[TimedWord], max_line_length: int) -> list[tuple[int, str]]:
    """Make readable LRC lines while preserving each line's first-word timestamp."""

    lines: list[tuple[int, str]] = []
    current_words: list[str] = []
    line_start_ms = 0
    previous_start_ms: int | None = None

    for word in words:
        proposed_line = " ".join([*current_words, word.text])
        has_long_pause = previous_start_ms is not None and word.start_ms - previous_start_ms > 900
        is_too_long = current_words and len(proposed_line) > max_line_length

        if has_long_pause or is_too_long:
            lines.append((line_start_ms, " ".join(current_words)))
            current_words = []

        if not current_words:
            line_start_ms = word.start_ms
        current_words.append(word.text)
        previous_start_ms = word.start_ms

    if current_words:
        lines.append((line_start_ms, " ".join(current_words)))
    return lines


def safe_lrc_text(text: str) -> str:
    """Avoid bracket characters being mistaken for additional LRC timestamps."""

    return re.sub(r"[\[\]]", "", text).strip()


def write_lrc(output_path: Path, title: str, artist: str, lines: list[tuple[int, str]]) -> None:
    header = [f"[ti:{safe_lrc_text(title)}]", f"[ar:{safe_lrc_text(artist)}]", "[by:AssemblyAI + yt-dlp]"]
    timed_lines = [f"[{to_lrc_timestamp(start_ms)}]{safe_lrc_text(text)}" for start_ms, text in lines]
    output_path.write_text("\n".join([*header, "", *timed_lines, ""]), encoding="utf-8")


def project_relative_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def update_spotify_catalog(
    catalog_path: Path,
    metadata: dict[str, Any],
    source_url: str,
    song_dir: Path,
    video_path: Path,
    audio_path: Path,
    lrc_path: Path,
) -> Path:
    """Create or update editable song metadata without overwriting manual title, author, or cover edits."""

    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog: dict[str, Any] = {"version": 1, "songs": []}
    if catalog_path.exists():
        try:
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Cannot update {catalog_path}: invalid JSON ({error.msg}).") from error

    songs = catalog.setdefault("songs", [])
    if not isinstance(songs, list):
        raise RuntimeError(f"Cannot update {catalog_path}: 'songs' must be a JSON array.")

    video_id = str(metadata["id"])
    existing = next((song for song in songs if isinstance(song, dict) and song.get("id") == video_id), {})
    downloaded_title = str(metadata.get("title") or video_id)
    downloaded_author = str(metadata.get("uploader") or metadata.get("channel") or "TikTok creator")

    cover_file = ensure_cover_image(song_dir, video_path, metadata.get("thumbnail"))
    default_cover = project_relative_path(cover_file) if cover_file else ""

    entry = {
        "id": video_id,
        "title": existing.get("title", downloaded_title),
        "author": existing.get("author", downloaded_author),
        "coverPath": existing.get("coverPath") or default_cover,
        "thumbnailUrl": metadata.get("thumbnail", ""),
        "sourceUrl": source_url,
        "folderPath": project_relative_path(song_dir),
        "videoPath": project_relative_path(video_path),
        "audioPath": project_relative_path(audio_path),
        "lyricsPath": project_relative_path(lrc_path),
        "durationSeconds": metadata.get("duration"),
        "top": existing.get("top", True),
        "madeForYou": existing.get("madeForYou", True),
        "recentlyAdded": existing.get("recentlyAdded", True),
        "nowPlaying": existing.get("nowPlaying", False),
    }

    if existing:
        songs[songs.index(existing)] = entry
    else:
        songs.append(entry)
    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return catalog_path


def main() -> int:
    args = parse_arguments()
    validate_tiktok_url(args.url)
    api_key = require_dependencies()

    print("Downloading video and extracting audio…")
    video_path, audio_path, metadata, song_dir = download_media(
        args.url,
        args.songs_dir,
        cookies=args.cookies,
        cookies_from_browser=args.cookies_from_browser,
    )
    print(f"Video: {video_path}")
    print(f"Audio: {audio_path}")

    print("Transcribing audio with AssemblyAI…")
    words = transcribe_audio(audio_path, args.language, api_key)
    title = str(metadata.get("title") or "TikTok audio")
    artist = str(metadata.get("uploader") or metadata.get("channel") or "TikTok creator")
    lrc_path = audio_path.with_suffix(".lrc")
    write_lrc(lrc_path, title, artist, group_words(words, args.max_line_length))
    catalog_path = update_spotify_catalog(
        args.catalog_path, metadata, args.url, song_dir, video_path, audio_path, lrc_path
    )
    print(f"Synced lyrics: {lrc_path}")
    print(f"Editable catalogue: {catalog_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (DownloadError, OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
