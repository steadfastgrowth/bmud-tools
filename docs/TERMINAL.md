# B-Mud Terminal (Tailscale SSH)

Run shell commands on **any host your Mac can SSH to** — typically everything on your **Tailnet**.

## How it works

```
2780 B-Mud  →  Mac relay :8790  →  ssh user@host  command
                              ↘  local shell if host is this Mac
```

- **Local host** (`local` / this Mac’s name or `100.x`): runs on the relay Mac with your login shell (no `sshd` needed).
- **Remote hosts**: `ssh -o BatchMode=yes` using the **Mac’s SSH keys/agent**. Password prompts are not supported on the flip.

## Phone UX

1. Hub → **Terminal**
2. **Refresh hosts** → pick a Tailscale peer
3. Set **User** (default = Mac username)
4. Type a **Command** → **Run**
5. Scroll **Output** lines with D-pad

## API

| Method | Path | Body / query |
|--------|------|----------------|
| GET | `/v1/term/hosts` | Tailscale status JSON → host list |
| POST | `/v1/term/exec` | `{ "host", "command", "user?", "port?", "timeout?" }` |

## Setup for remote hosts

On each machine you want to reach:

```bash
# copy your Mac public key
ssh-copy-id user@100.x.y.z
# or install the key manually in ~/.ssh/authorized_keys
```

Enable **Remote Login** (sshd) on macOS targets: System Settings → General → Sharing → Remote Login.

## Security

- Same `POCKET_TOKEN` as the rest of the bridge.
- Anyone with the token can run commands as your Mac’s SSH identity — keep the relay on LAN/tailnet only.
- Prefer least-privilege keys / Tailscale ACLs for production.
