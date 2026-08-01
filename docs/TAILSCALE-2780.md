# Nokia 2780 on Tailscale (jailbreak)

Official KaiOS has **no Tailscale app**. On a **rooted/jailbroken** 2780 we run the official **Linux ARMv7** static binaries.

## Status (worked on device)

| Item | Value |
|------|--------|
| Hostname | `nokia-2780` |
| Tailscale IP | (see `tailscale status` / phone `ip -4`) |
| Binaries | `/data/local/tailscale/tailscale{,d}` |
| Socket | `/data/local/tailscale/tailscaled.sock` |

## One-time install

On a Mac with `adb` + device USB debugging:

```bash
# download official static arm build
VER=1.98.10
curl -fsSL -O https://pkgs.tailscale.com/stable/tailscale_${VER}_arm.tgz
tar -xzf tailscale_${VER}_arm.tgz
adb push tailscale_${VER}_arm/tailscale /data/local/tmp/
adb push tailscale_${VER}_arm/tailscaled /data/local/tmp/
adb shell 'su -c "mkdir -p /data/local/tailscale/state /dev/net
  cp /data/local/tmp/tailscale /data/local/tmp/tailscaled /data/local/tailscale/
  chmod 755 /data/local/tailscale/tailscale /data/local/tailscale/tailscaled
  ln -sf /dev/tun /dev/net/tun"'
```

## Critical Android routing fix

Android keeps the default route in a per-interface table (`table wlan0`).  
Go/`tailscaled` uses the **main** table → without a main default route you get:

`network is unreachable` / DNS bootstrap failures.

```sh
ip route replace default via <wifi-gateway> dev wlan0 metric 50
```

`start-tailscale.sh` does this automatically.

## Login

```sh
adb shell 'su -c "/data/local/tailscale/start-tailscale.sh"'
adb shell 'su -c "/data/local/tailscale/tailscale --socket=/data/local/tailscale/tailscaled.sock login --hostname=nokia-2780"'
# open the https://login.tailscale.com/a/... URL on any device, approve
```

## B-Mud bridge over tailnet

On the phone **Settings → Bridge URL**:

```
http://100.x.y.z:8790
```

Use your Mac’s **Tailscale IPv4** (`tailscale ip -4` on the Mac that runs the relay), not the LAN IP.  
Token unchanged.

When phone and Mac are both on home Wi‑Fi, Tailscale usually uses a **direct** path (fast). Away from home, traffic goes over DERP/relay as usual.

## Boot persistence

Script: `/data/local/tailscale/start-tailscale.sh`  
Also copied to `/data/adb/service.d/99tailscale.sh` when Magisk-style hooks exist.

After reboot, if not auto-started:

```bash
adb shell 'su -c /data/local/tailscale/start-tailscale.sh'
# or host helper:
n2780-tailscale start
```

## Caveats

1. **Not official support** — may break on OTA / power modes.
2. **Battery** — `tailscaled` is always-on userspace + tunnel; expect some drain.
3. **Reboot** — confirm auto-start; re-run start script if needed.
4. **B2G / app routing** — root connectivity was verified; if the KaiOS app cannot reach `100.x`, ensure `tailscale0` is up and test `curl` as the `b2g` user if available.
5. **Security** — treat the handset as a full tailnet node; use ACLs if you share the tailnet.

## Host helper

```bash
n2780-tailscale status
n2780-tailscale start
n2780-tailscale stop
n2780-tailscale ip
```
