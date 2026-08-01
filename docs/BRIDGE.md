# Bridge / relay API (Mac)

The phone is a thin client. Heavy work runs on a Mac (or Mini) relay.

## Endpoints used by the phone

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Status (no auth required) |
| POST | `/v1/chat` | Notes-context AI |
| POST | `/v1/summarize` | Summarize notes |
| POST | `/v1/hermes` | Local Hermes agent |
| POST | `/v1/stt` | Speech-to-text (multipart audio) |
| POST | `/v1/music/search` | Spotify search |
| POST | `/v1/music/control` | Spotify Connect control |
| GET | `/v1/music/devices` | Spotify devices |
| GET | `/v1/messages/chats` | iMessage chats |
| GET | `/v1/messages/history` | Thread history |
| POST | `/v1/messages/send` | Send message |
| GET | `/v1/contacts` | Search macOS contacts |

Auth: `Authorization: Bearer <POCKET_TOKEN>` (and/or `X-Pocket-Token`).

## Privacy split

| Route | Goes to |
|-------|---------|
| `/v1/messages/*`, `/v1/contacts`, `/v1/music/*`, `/v1/hermes` | **Local Mac only** |
| `/v1/chat`, `/v1/summarize`, `/v1/stt` | Proxied to `MINI_BRIDGE` if configured |

## macOS Full Disk Access

`imsg` needs FDA to read `~/Library/Messages/chat.db`. Grant FDA to:

1. The terminal/app that launches the relay  
2. The `imsg` binary itself  

Contacts come from `~/Library/Application Support/AddressBook`.
