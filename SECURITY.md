# Security

## Do not commit secrets

- Phone **Token** and Mac `POCKET_TOKEN` are shared secrets. Generate your own.
- Never commit `.env`, real bridge URLs with credentials, or API keys.
- This app talks to a **LAN bridge** with `systemXHR`. Treat your token like a password.

## Threat model (home lab)

This stack is designed for a **trusted home network**:

- KaiOS handset → HTTP → Mac relay on your LAN
- Optional Mini host for LLM/STT
- iMessage access via `imsg` requires **Full Disk Access** on macOS

Do **not** expose the relay port to the public internet without TLS, auth hardening, and a firewall.

## Reporting issues

Open a GitHub issue for non-sensitive bugs. For something that could compromise users (token bypass, injection, etc.), describe it without exploit details first and mark it security-sensitive.
