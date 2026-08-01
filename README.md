# B-Mud Tools

**Dumb backwards. Smart bridge.**

A [KaiOS](https://www.kaiostech.com/) flip-phone app (built for **Nokia 2780**) that turns a low-power handset into a pocket UI for:

- **Notes + voice** (side-button STT via Mac bridge)
- **AI** (notes-context chat, or **Hermes** agent on your Mac)
- **Messages** (iMessage/SMS via Mac [`imsg`](https://github.com/steipete/imsg))
- **Contacts** (macOS Address Book search)
- **Music** (30s previews on the phone + Spotify Connect remote)
- **Maps** (OpenStreetMap search + text turn-by-turn; private)

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
Maps: [docs/MAPS.md](docs/MAPS.md).

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
- See [SECURITY.md](SECURITY.md).

---

## Requirements

| Piece | Notes |
|-------|--------|
| KaiOS handset | Tested on Nokia 2780 (KaiOS 3.x) |
| Mac relay | Python 3.10+, optional `imsg`, Spotify (Hermes tokens), Hermes CLI |
| Jailbreak tools | Only for ADB/`appscmd` deploy; not required for hosted HTML |

---

## Contributing

PRs welcome for nav UX, bridge endpoints, and device support beyond the 2780. Keep secrets out of commits. Prefer small, testable changes.

---

## License

[MIT](LICENSE)

---

*B-Mud: dumb backwards · smart bridge.*
