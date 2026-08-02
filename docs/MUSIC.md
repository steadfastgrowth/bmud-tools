# B-Mud Music

Control and browse **your** Spotify account from the flip. Full-fidelity playback uses **Spotify Connect** on a device where Spotify is officially installed (Mac, TV, phone app).

## Supported (default / recommended)

| Feature | How |
|---------|-----|
| Recently played, liked songs, playlists, search | [Spotify Web API](https://developer.spotify.com/documentation/web-api) with **your** OAuth tokens |
| Full-quality playback | **Remote** mode → Spotify Connect (`/me/player/*`) |
| Short clips on the flip speaker | Spotify `preview_url` when present, else public iTunes 30s previews |
| Devices / now playing / prev / pause / next | Official player API |

This is the path that stays aligned with normal third-party Spotify API use: you authenticate, you control **your** Premium session on **official** Connect targets.

## Phone UX

1. **Music** → **Recent** / **Liked** / **Playlists** / **Search**
2. **Mode: Remote** (recommended for full tracks) → Select starts Connect playback
3. **Mode: Phone** → Select plays whatever the relay can put on the handset (previews by default)
4. **Devices** → pick Mac / TV / other Connect targets
5. **Remote full** / **Prev** / **Pause** / **Next** for transport

Badges: `PHONE` = handset clip available · `REMOTE` = use Connect for full track.

## Experimental: handset “full length” match (`MUSIC_MATCH_FULL`)

Spotify’s Web API **does not** expose full-track audio files to third-party apps. That is intentional.

This repo includes an **optional, disabled-by-default** experiment that tries to resolve a separate full-length audio source for personal handset playback when `MUSIC_MATCH_FULL=1`. It is:

- **Not** affiliated with Spotify, Google, or Apple  
- **Not** official Spotify streams or DRM circumvention of Spotify’s player  
- **Not** a feature we market as “free Spotify on KaiOS”  
- **Your responsibility** if you enable it (third-party terms of service and local law)

### Defaults (public / OSS)

```bash
MUSIC_MATCH_FULL=0          # default — previews + Connect only
# MUSIC_MATCH_FULL=1        # opt-in experiment only; read above first
YTDLP=/opt/homebrew/bin/yt-dlp   # only used when match-full is enabled
```

If match-full is off, `/v1/music/stream` serves previews only (or 404 → use Remote).

## API (relay)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/v1/music/recent` | Recently played |
| GET | `/v1/music/liked` | Saved tracks |
| GET | `/v1/music/playlists` | User playlists |
| GET | `/v1/music/playlist?id=` | Playlist items |
| GET | `/v1/music/now` | Now playing |
| GET | `/v1/music/devices` | Connect devices |
| GET | `/v1/music/stream` | Handset audio proxy (preview; match only if opted in) |
| POST | `/v1/music/control` | Connect play/pause/next/… |
| POST | `/v1/music/search` | Track search |
| POST | `/v1/music/resolve` | Resolve handset audio metadata |

Auth: same `POCKET_TOKEN` as the rest of the bridge. Stream may also accept `?token=` for `<audio src>`.

## Setup

1. Log Spotify into Hermes (or equivalent) so `~/.hermes/auth.json` has a Spotify provider with playback + library scopes.  
2. Open the **Spotify app** on at least one Connect-capable device (Mac/TV).  
3. Point the phone at the Mac relay; use **Remote** for full tracks.

## Compliance note

B-Mud is a **local automation bridge**. It does not ship music files, Spotify credentials, or a multi-tenant streaming service. Operators run the relay on hardware they control and use their own accounts. See [DISCLAIMER.md](../DISCLAIMER.md) and [SECURITY.md](../SECURITY.md).
