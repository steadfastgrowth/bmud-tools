# Security

## Do not commit secrets

- Phone **Token** and Mac `POCKET_TOKEN` are shared secrets. Generate your own.
- Never commit `.env`, real bridge URLs with credentials, OAuth tokens, or API keys.
- Keep `js/config.local.js` gitignored (personal bridge URL + token).
- This app talks to a **LAN bridge** with `systemXHR`. Treat your token like a password.
- If a secret was ever committed, **rotate it** (new token / revoke OAuth) — history rewrite alone is not enough if the old secret was pushed.

## Threat model (home lab)

This stack is designed for a **trusted home network**:

- KaiOS handset → HTTP → Mac relay on your LAN
- Optional Mini host for LLM/STT
- iMessage access via `imsg` requires **Full Disk Access** on macOS

Do **not** expose the relay port to the public internet without TLS, auth hardening, and a firewall. Do **not** run the relay as a multi-tenant public service.

## Third-party accounts

You connect **your own** Spotify (and other) accounts. Keep developer apps and OAuth clients under your control. Revoke access if a device or token is lost. See [DISCLAIMER.md](DISCLAIMER.md) for ToS / compliance framing.

## Defaults that reduce blast radius

- Relay requires `POCKET_TOKEN` (see `relay/run.sh`).
- Music **match-full** handset streams are **off** unless you set `MUSIC_MATCH_FULL=1` ([docs/MUSIC.md](docs/MUSIC.md)).

## Reporting issues

Open a GitHub issue for non-sensitive bugs. For something that could compromise users (token bypass, injection, etc.), describe it without exploit details first and mark it security-sensitive.
