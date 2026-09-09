import json
import os
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = PROJECT_ROOT / "src" / "data" / "spotify.json"

def main():
    with open(CATALOG_PATH, "r", encoding="utf-8") as f:
        catalog = json.load(f)

    songs = catalog.get("songs", [])
    updated_songs = 0

    for song in songs:
        folder_rel = song.get("folderPath", "")
        folder = PROJECT_ROOT / folder_rel
        video_rel = song.get("videoPath", "")
        video_path = PROJECT_ROOT / video_rel

        # Check existing covers in folder
        cover_path_current = song.get("coverPath", "").strip()
        local_cover_exists = False
        
        if cover_path_current:
            full_cover = PROJECT_ROOT / cover_path_current
            if full_cover.exists() and full_cover.stat().st_size > 0:
                local_cover_exists = True

        if not local_cover_exists:
            # Check if there is already a cover.jpg or image.png in the song folder
            existing_cover = None
            for name in ["cover.jpg", "cover.png", "image.png"]:
                candidate = folder / name
                if candidate.exists() and candidate.stat().st_size > 0:
                    existing_cover = candidate
                    break

            target_cover = folder / "cover.jpg"
            if not existing_cover:
                if not video_path.exists():
                    print(f"[SKIP] Video not found for {song['id']}: {video_path}")
                    continue
                
                print(f"[EXTRACT] Extracting cover for '{song.get('title')}' ({song['id']}) from {video_path.name}...")
                cmd = [
                    "ffmpeg", "-y",
                    "-ss", "00:00:01.5",
                    "-i", str(video_path),
                    "-vframes", "1",
                    "-q:v", "2",
                    str(target_cover)
                ]
                res = subprocess.run(cmd, capture_output=True, text=True)
                if res.returncode != 0 or not target_cover.exists() or target_cover.stat().st_size == 0:
                    # Fallback to 00:00:00.5
                    cmd[2] = "00:00:00.5"
                    res = subprocess.run(cmd, capture_output=True, text=True)
                
                if res.returncode == 0 and target_cover.exists() and target_cover.stat().st_size > 0:
                    existing_cover = target_cover
                    print(f"  -> Extracted cover.jpg ({target_cover.stat().st_size} bytes)")
                else:
                    print(f"  [ERROR] FFmpeg failed: {res.stderr}")
                    continue
            
            # Update song coverPath
            rel_cover = existing_cover.relative_to(PROJECT_ROOT).as_posix()
            song["coverPath"] = rel_cover
            print(f"  -> Set coverPath: {rel_cover}")
            updated_songs += 1

    # Check playlists
    playlists = catalog.get("playlists", [])
    updated_playlists = 0
    song_map = {s["id"]: s for s in songs}

    for pl in playlists:
        pl_cover = pl.get("coverPath", "").strip()
        pl_cover_file = PROJECT_ROOT / pl_cover if pl_cover else None
        if not pl_cover or not (pl_cover_file and pl_cover_file.exists()):
            song_ids = pl.get("songIds", [])
            for sid in song_ids:
                track = song_map.get(sid)
                if track and track.get("coverPath"):
                    track_cover_file = PROJECT_ROOT / track["coverPath"]
                    if track_cover_file.exists():
                        pl["coverPath"] = track["coverPath"]
                        print(f"[PLAYLIST] Updated playlist '{pl['title']}' cover to {track['coverPath']}")
                        updated_playlists += 1
                        break

    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"\nDone! Updated {updated_songs} songs and {updated_playlists} playlists.")
    print("\n--- Catalog Verification ---")
    for s in catalog.get("songs", []):
        cp = s.get("coverPath", "")
        p = PROJECT_ROOT / cp if cp else None
        exists = p.exists() and p.stat().st_size > 0 if p else False
        status = "OK" if exists else "MISSING"
        size = p.stat().st_size if exists else 0
        print(f"[{status}] {s['id']} - {s.get('title')} -> {cp} ({size} bytes)")

    for pl in catalog.get("playlists", []):
        cp = pl.get("coverPath", "")
        p = PROJECT_ROOT / cp if cp else None
        exists = p.exists() and p.stat().st_size > 0 if p else False
        status = "OK" if exists else "MISSING"
        size = p.stat().st_size if exists else 0
        print(f"[{status}] Playlist {pl['id']} -> {cp} ({size} bytes)")

if __name__ == "__main__":
    main()
