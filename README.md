# B-Mud Tools

**Dumb backwards. Smart bridge.**

A [KaiOS](https://www.kaiostech.com/) flip-phone app (built for **Nokia 2780**) that turns a low-power handset into a pocket UI for:

- **Notes + voice** (side-button STT via Mac bridge)
- **AI** (notes-context chat, or **Hermes** agent on your Mac)
- **Messages** (iMessage/SMS via Mac [`imsg`](https://github.com/steipete/imsg))
- **Contacts** (macOS Address Book search)
- **Music** (Spotify library browse + **Connect remote** for full tracks; handset previews by default)
- **Maps** (OpenStreetMap search + text turn-by-turn; private)
- **Terminal** (SSH any Tailscale host via Mac keys)
- **Podcasts** (free public RSS → play on the handset)

```
Nokia 2780 (B-Mud)  --HTTP/LAN-->  Mac relay :8790
                                      ├─ imsg / Contacts / Spotify / Hermes
                                      └─ optional Mini :8787  (LLM + STT)
```

---

## Repo layout

```
index.html          # UI + KaiOS-safe scroll layout
js/core.js          # D-pad nav, screens, STT keys
js/bridge.js        # Bridge HTTP client
js/storage.js       # notes, settings, session, log
icons/              # app icons
scripts/deploy.sh   # package + adb install (jailbroken device)
relay/              # optional Mac relay (Python)
docs/               # bridge notes
```

Live path is **only** the files above. Older modular experiments are not required.

---

## Phone app (quick start)

### 1. Package

```bash
mkdir -p dist
zip -9 -r dist/bmud.kaios.zip \
  index.html manifest.webapp manifest.webmanifest \
  js/core.js js/bridge.js js/storage.js \
  icons/icon-56.png icons/icon-112.png icons/icon-512.png
```

### 2. Install on device

**Jailbroken 2780 with `appscmd` + ADB** (recommended for dev):

```bash
export ADB_VENDOR_KEYS=/path/to/adbkey   # if your JB image needs it
bash scripts/deploy.sh
```

Or manually:

```bash
adb push dist/bmud.kaios.zip /data/local/tmp/
adb shell appscmd install /data/local/tmp/bmud.kaios.zip
# extract if your install only drops application.zip:
adb shell "su -c 'cd /data/local/webapps/installed/bmudtools && unzip -o application.zip'"
```

**Hosted install (no sideload):** serve the folder over LAN and open it in the phone browser, or use WebIDE / community tools for your firmware.

### 3. Configure on phone

**Settings →**

| Field | Example |
|-------|---------|
| Bridge URL | `http://192.168.1.10:8790` (your Mac’s LAN IP) |
| Token | same as `POCKET_TOKEN` on the Mac |

**Ping** should go online.

---

## Mac relay (optional but where the magic is)

```bash
cd relay
cp .env.example .env   # edit POCKET_TOKEN, paths
export $(grep -v '^#' .env | xargs)
# Install imsg: https://github.com/steipete/imsg
# Grant Full Disk Access to your terminal + imsg binary
./run.sh
```

Health check:

```bash
curl -s http://127.0.0.1:8790/health | python3 -m json.tool
```

See [docs/BRIDGE.md](docs/BRIDGE.md) for routes and privacy notes.  
Maps · [docs/MAPS.md](docs/MAPS.md) · Terminal · [docs/TERMINAL.md](docs/TERMINAL.md) · Podcasts · [docs/PODCASTS.md](docs/PODCASTS.md) · Music · [docs/MUSIC.md](docs/MUSIC.md) · STT · [docs/STT.md](docs/STT.md).

---

## Disclaimer (read this)

B-Mud is an **independent** open-source project. It is **not** affiliated with Spotify, Google, Apple, Nokia/HMD, or KaiOS.

- You run the relay **yourself** on hardware you control.  
- You use **your own** accounts and API tokens.  
- **Spotify full-quality audio** is intended via **Spotify Connect** (official player on Mac/TV/etc.), not by redistributing Spotify’s catalog.  
- Optional experimental flags (if you enable them) are **your** compliance responsibility.  
- Full text: **[DISCLAIMER.md](DISCLAIMER.md)** · security: **[SECURITY.md](SECURITY.md)** · license: **[MIT](LICENSE)** (“AS IS”).

Publishing this code does not grant anyone a license to third-party content or services.

---

## D-pad map (2780)

| Key | Action |
|-----|--------|
| ↑ / ↓ | Move focus (scrolls the active view) |
| Select / Enter | Activate (open tool, Ask, play track, …) |
| Soft Left | Home |
| Soft Right | Back |
| Side button (Call / PROG1) | STT toggle into focused field |

---

## Personal device defaults (optional)

Create `js/config.local.js` (gitignored) on your machine to seed Settings:

```js
var PocketLocalConfig = {
  bridgeUrl: 'http://192.168.1.10:8790',
  token: 'your-shared-secret',
  aiMode: 'notes'
};
```

Then load it **before** `storage.js` in your private deploy package (do not commit this file).

## Security

- **No tokens or API keys ship in this repo.** Set your own.
- LAN-only by design. Do not port-forward the relay blindly.
- See [SECURITY.md](SECURITY.md) and [DISCLAIMER.md](DISCLAIMER.md).

---

## Requirements

| Piece | Notes |
|-------|--------|
| KaiOS handset | Tested on Nokia 2780 (KaiOS 3.x) |
| Mac relay | Python 3.10+, optional `imsg`, Spotify (Hermes tokens), Hermes CLI |
| Jailbreak tools | Only for ADB/`appscmd` deploy; not required for hosted HTML |

---

## Contributing

PRs welcome for nav UX, bridge endpoints, and device support beyond the 2780.

- Keep secrets out of commits (`js/config.local.js` is gitignored).  
- Prefer small, testable changes.  
- Do not add code that turns the relay into a public multi-user stream host.  
- Keep **safe defaults** for anything that touches third-party media terms (see music defaults in [docs/MUSIC.md](docs/MUSIC.md)).

---

## License

[MIT](LICENSE) — free to use and fork; **no warranty**. Third-party services remain under **their** terms.

---

*B-Mud: dumb backwards · smart bridge.*
