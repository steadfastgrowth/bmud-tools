# B-Mud Terminal (Tailscale SSH)

Run shell commands on **any host your Mac can SSH to** — typically everything on your **Tailnet**.

## How it works

```
2780 B-Mud  →  Mac relay :8790  →  ssh user@host  command
                              ↘  local shell if host is this Mac
```

- **Local host** (`local` / this Mac’s name or `100.x`): runs on the relay Mac with your login shell (no `sshd` needed).
- **Remote hosts**: SSH from the Mac. Prefer **keys** (`BatchMode`); or fill **Password** on the flip for one-shot `SSH_ASKPASS` password auth.

## Phone UX

1. Hub → **Terminal**
2. **Refresh hosts** → pick a Tailscale peer
3. Set **User** (default = Mac username)
4. Optional: **Password** for remote hosts without keys (paste/type; blank = keys only)
5. Type a **Command** → **Run**
6. Scroll **Output** lines with D-pad

## API

| Method | Path | Body / query |
|--------|------|----------------|
| GET | `/v1/term/hosts` | Tailscale status JSON → host list |
| POST | `/v1/term/exec` | `{ "host", "command", "user?", "password?", "port?", "timeout?" }` |

Password is only used for remote SSH. It is never stored on the phone (field only) and is not written to the event log.

## Setup for remote hosts

**Option A — keys (best):**
```bash
# copy your Mac public key
ssh-copy-id user@100.x.y.z
# or install the key manually in ~/.ssh/authorized_keys
```

**Option B — password:** fill the Password field on the flip before **Run**. The relay feeds OpenSSH via `SSH_ASKPASS` (no interactive TTY).

Enable **Remote Login** (sshd) on macOS targets: System Settings → General → Sharing → Remote Login.

## Security

- Same `POCKET_TOKEN` as the rest of the bridge.
- Anyone with the token can run commands as your Mac’s SSH identity — keep the relay on LAN/tailnet only.
- Prefer least-privilege keys / Tailscale ACLs for production.


## Grok / interactive TUI tools

The flip terminal has **no real TTY**. Apps that open a full-screen UI fail with:

`Error: Device not configured (os error 6)`

**Works (headless):**
```bash
grok -p "explain this error"
grok --print "hi"
hostname; uptime; ls
```

**Does not work:**
```bash
grok          # interactive TUI
vim file.py   # needs TTY
```
