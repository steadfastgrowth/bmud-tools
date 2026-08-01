#!/usr/bin/env python3
"""Pocket relay: iMessage (imsg) + Hermes agent + proxy AI/STT to Mini.

PRIVACY:
  /v1/messages/*  → local imsg ONLY (never Mini/Grok)
  /v1/hermes      → local hermes CLI on this Mac
  /v1/music/*     → Spotify Connect on this Mac (Hermes tokens)
  other routes    → Mini bridge (Grok/Whisper)

  export POCKET_TOKEN=your-shared-secret
  export MINI_BRIDGE=http://127.0.0.1:8787   # optional Mini AI/STT
  export IMSG_BIN=imsg                       # or full path to imsg binary
  export HERMES_BIN=hermes
  python3 pocket_relay.py
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = os.environ.get("RELAY_HOST", "0.0.0.0")
PORT = int(os.environ.get("RELAY_PORT", "8790"))
TOKEN = os.environ.get("POCKET_TOKEN", "")
MINI = os.environ.get("MINI_BRIDGE", "http://127.0.0.1:8787").rstrip("/")
IMSG = os.path.expanduser(os.environ.get("IMSG_BIN", "imsg"))
HERMES = os.environ.get("HERMES_BIN", "hermes")
HERMES_TIMEOUT = int(os.environ.get("HERMES_TIMEOUT", "300"))

_CONTACT_CACHE: dict[str, str] = {}  # phone digits / email → display name
_CONTACT_LIST: list[dict[str, Any]] = []  # [{name, phones, emails}]
_CONTACT_LOADED = False
_CONTACT_LOAD_ERROR: str | None = None


def digits_only(s: str) -> str:
    return re.sub(r"\D+", "", s or "")


def _person_name(fn: Any, ln: Any, nick: Any = None, org: Any = None) -> str:
    name = " ".join(x for x in [fn, ln] if x).strip()
    if not name:
        name = (nick or org or "").strip()
    return name


def load_contacts(force: bool = False) -> None:
    """Load macOS AddressBook into lookup cache + searchable list.

    Retries when previous load was empty (e.g. FDA granted after first boot).
    """
    global _CONTACT_LOADED, _CONTACT_CACHE, _CONTACT_LIST, _CONTACT_LOAD_ERROR
    if _CONTACT_LOADED and not force and (_CONTACT_LIST or _CONTACT_CACHE):
        return
    # If we already tried and have data, skip unless force
    if _CONTACT_LOADED and not force and _CONTACT_LOAD_ERROR is None and not _CONTACT_LIST:
        # empty successful load — still allow periodic force from API
        if not force:
            return

    cache: dict[str, str] = {}
    # key = lower name → aggregate
    by_key: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    ab = Path.home() / "Library/Application Support/AddressBook"
    dbs = list(ab.glob("**/*.abcddb"))

    def ensure_person(name: str) -> dict[str, Any]:
        k = name.lower()
        if k not in by_key:
            by_key[k] = {"name": name, "phones": [], "emails": []}
        return by_key[k]

    for db in dbs:
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            q = """
            SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION,
                   p.ZFULLNUMBER, p.ZLASTFOURDIGITS
            FROM ZABCDPHONENUMBER p
            LEFT JOIN ZABCDRECORD r ON p.ZOWNER = r.Z_PK
            """
            for fn, ln, nick, org, full, last4 in con.execute(q):
                name = _person_name(fn, ln, nick, org)
                if not name:
                    continue
                person = ensure_person(name)
                raw_phone = (full or "").strip()
                if raw_phone and raw_phone not in person["phones"]:
                    person["phones"].append(raw_phone)
                for raw in (full or "", last4 or ""):
                    d = digits_only(raw)
                    if len(d) >= 4:
                        cache[d] = name
                        if len(d) >= 10:
                            cache[d[-10:]] = name
                            cache[d[-7:]] = name
            try:
                qe = """
                SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION, e.ZADDRESS
                FROM ZABCDEMAILADDRESS e
                LEFT JOIN ZABCDRECORD r ON e.ZOWNER = r.Z_PK
                """
                for fn, ln, nick, org, addr in con.execute(qe):
                    name = _person_name(fn, ln, nick, org)
                    if not name or not addr:
                        continue
                    person = ensure_person(name)
                    em = str(addr).strip()
                    if em and em not in person["emails"]:
                        person["emails"].append(em)
                    cache[em.lower()] = name
            except Exception:
                pass
            con.close()
        except Exception as e:
            errors.append(f"{db.name}: {e}")
            print("[relay] contacts skip", db, e)

    _CONTACT_CACHE = cache
    # Prefer contacts that have a phone (useful for SMS/iMessage)
    people = list(by_key.values())
    people.sort(key=lambda p: (p["name"] or "").lower())
    _CONTACT_LIST = people
    _CONTACT_LOADED = True
    _CONTACT_LOAD_ERROR = "; ".join(errors) if errors and not people else None
    print(f"[relay] contacts loaded: {len(_CONTACT_LIST)} people, {len(_CONTACT_CACHE)} keys")


def search_contacts(q: str, limit: int = 30) -> dict[str, Any]:
    load_contacts()
    q = (q or "").strip().lower()
    q_digits = digits_only(q)
    out: list[dict[str, Any]] = []
    for p in _CONTACT_LIST:
        name = p.get("name") or ""
        phones = p.get("phones") or []
        emails = p.get("emails") or []
        if not q:
            hit = True
        else:
            hit = q in name.lower()
            if not hit and q_digits:
                for ph in phones:
                    if q_digits in digits_only(ph):
                        hit = True
                        break
            if not hit:
                for em in emails:
                    if q in em.lower():
                        hit = True
                        break
        if not hit:
            continue
        # Primary "to" for messaging: first phone, else first email
        to = phones[0] if phones else (emails[0] if emails else "")
        out.append(
            {
                "name": name,
                "to": to,
                "phones": phones,
                "emails": emails,
            }
        )
        if len(out) >= limit:
            break
    return {
        "contacts": out,
        "count": len(out),
        "total_loaded": len(_CONTACT_LIST),
        "query": q,
    }


def resolve_name(handle: str, fallback: str = "") -> str:
    load_contacts()
    if not handle:
        return fallback or ""
    h = handle.strip()
    if h.lower() in _CONTACT_CACHE:
        return _CONTACT_CACHE[h.lower()]
    d = digits_only(h)
    for key in (d, d[-10:] if len(d) >= 10 else "", d[-7:] if len(d) >= 7 else ""):
        if key and key in _CONTACT_CACHE:
            return _CONTACT_CACHE[key]
    if fallback:
        return fallback
    return h


def imsg_json(args: list[str], timeout: int = 45) -> Any:
    cmd = [IMSG] + args + ["--json"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "imsg failed").strip()
        raise RuntimeError(err)
    out = (p.stdout or "").strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        lines = [ln for ln in out.splitlines() if ln.strip().startswith(("{", "["))]
        if not lines:
            return {"raw": out}
        if len(lines) == 1:
            return json.loads(lines[0])
        return [json.loads(ln) for ln in lines]


def proxy(method: str, path: str, body: bytes | None, headers: dict) -> tuple[int, bytes, str]:
    url = MINI + path
    req = urllib.request.Request(url, data=body, method=method)
    for k, v in headers.items():
        if k.lower() in ("host", "content-length"):
            continue
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "application/json")
    except Exception as e:
        return 502, json.dumps({"error": f"proxy: {e}"}).encode(), "application/json"


def normalize_chats(data: Any) -> list[dict]:
    if data is None:
        return []
    if isinstance(data, dict):
        items = data.get("chats") or data.get("items") or data.get("data") or []
        if not items and data.get("id") is not None:
            items = [data]
    elif isinstance(data, list):
        items = data
    else:
        items = []
    out = []
    for c in items:
        if not isinstance(c, dict):
            continue
        cid = c.get("id") if c.get("id") is not None else c.get("chat_id")
        parts = c.get("participants") or []
        ident = c.get("identifier") or ""
        dn = (c.get("display_name") or c.get("name") or "").strip()
        # Prefer group/display name; else resolve first participant / identifier
        title = dn
        if not title:
            handle = ident if not str(ident).startswith("chat") else (parts[0] if parts else "")
            title = resolve_name(handle, handle or f"Chat {cid}")
        else:
            # keep group names; still nice
            title = title.strip()
        to = ident if not str(ident).startswith("chat") else (parts[0] if len(parts) == 1 else None)
        if to and not dn and len(parts) == 1:
            title = resolve_name(to, title)
        last_at = c.get("last_message_at") or c.get("last_at") or c.get("date")
        unread = int(c.get("unread_count") or c.get("unread") or 0)
        out.append(
            {
                "id": str(cid),
                "title": title,
                "to": to,
                "preview": c.get("preview") or "",
                "last_at": last_at,
                "unread_count": unread,
                "is_group": bool(c.get("is_group")),
                "participants": parts,
            }
        )
    # newest activity first
    out.sort(key=lambda x: x.get("last_at") or "", reverse=True)
    return out


def normalize_messages(data: Any) -> list[dict]:
    if data is None:
        return []
    if isinstance(data, dict):
        items = data.get("messages") or data.get("items") or data.get("data") or []
    elif isinstance(data, list):
        items = data
    else:
        items = []
    out = []
    for m in items:
        if not isinstance(m, dict):
            continue
        sender_raw = m.get("sender") or m.get("handle") or ""
        me = bool(m.get("is_from_me") or m.get("from_me") or m.get("isFromMe"))
        sender_name = "You" if me else resolve_name(sender_raw, sender_raw)
        out.append(
            {
                "id": m.get("id") or m.get("guid"),
                "text": m.get("text") or m.get("body") or "",
                "is_from_me": me,
                "sender": sender_name,
                "sender_raw": sender_raw,
                "date": m.get("created_at") or m.get("date") or m.get("timestamp"),
                "chat_name": (m.get("chat_name") or "").strip(),
            }
        )
    # imsg returns newest-first → chronological for chat UI (oldest top, newest bottom)
    def key(m: dict) -> str:
        return m.get("date") or ""

    out.sort(key=key)
    return out


def run_hermes(prompt: str, continue_session: bool = False) -> dict:
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("empty prompt")
    cmd = [HERMES, "chat", "-q", prompt, "-Q", "--yolo"]
    if continue_session:
        cmd.append("--continue")
    # Prefer tools that make sense from flip; full agent still OK
    env = os.environ.copy()
    env["HERMES_ACCEPT_HOOKS"] = env.get("HERMES_ACCEPT_HOOKS", "1")
    t0 = time.time()
    p = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=HERMES_TIMEOUT,
        env=env,
    )
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    session_id = None
    reply_lines = []
    for ln in out.splitlines():
        if ln.startswith("session_id:"):
            session_id = ln.split(":", 1)[1].strip()
        else:
            reply_lines.append(ln)
    reply = "\n".join(reply_lines).strip() or out
    if p.returncode != 0 and not reply:
        raise RuntimeError(err or f"hermes exit {p.returncode}")
    return {
        "ok": p.returncode == 0,
        "reply": reply,
        "session_id": session_id,
        "elapsed_s": round(time.time() - t0, 2),
        "error": err if p.returncode != 0 else None,
    }


# --- Spotify (Hermes auth.json PKCE tokens) ---
AUTH_JSON = Path.home() / ".hermes" / "auth.json"
_spotify_token_cache: dict[str, Any] = {}


def _load_spotify_provider() -> dict:
    if not AUTH_JSON.exists():
        return {}
    try:
        data = json.loads(AUTH_JSON.read_text())
        return (data.get("providers") or {}).get("spotify") or {}
    except Exception:
        return {}


def spotify_access_token(force_refresh: bool = False) -> str:
    """Return a valid access token, refreshing via PKCE refresh_token when needed."""
    now = time.time()
    if not force_refresh and _spotify_token_cache.get("token") and _spotify_token_cache.get("exp", 0) > now + 60:
        return str(_spotify_token_cache["token"])

    sp = _load_spotify_provider()
    if not sp:
        raise RuntimeError("Spotify not logged in — run: hermes auth spotify login")

    access = sp.get("access_token") or ""
    exp_raw = sp.get("expires_at") or ""
    exp_ts = 0.0
    if exp_raw:
        try:
            # 2026-08-01T16:27:01.651034+00:00
            from datetime import datetime
            exp_ts = datetime.fromisoformat(exp_raw.replace("Z", "+00:00")).timestamp()
        except Exception:
            exp_ts = 0.0

    if access and exp_ts > now + 60 and not force_refresh:
        _spotify_token_cache["token"] = access
        _spotify_token_cache["exp"] = exp_ts
        return access

    refresh = sp.get("refresh_token")
    client_id = sp.get("client_id") or os.environ.get("SPOTIFY_CLIENT_ID") or os.environ.get("HERMES_SPOTIFY_CLIENT_ID")
    if not refresh or not client_id:
        if access:
            return access
        raise RuntimeError("Spotify token expired and no refresh_token")

    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": client_id,
        }
    ).encode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        tok = json.loads(resp.read().decode())
    access = tok.get("access_token") or ""
    if not access:
        raise RuntimeError("Spotify refresh failed")
    expires_in = int(tok.get("expires_in") or 3600)
    # persist back into auth.json
    try:
        data = json.loads(AUTH_JSON.read_text())
        prov = data.setdefault("providers", {}).setdefault("spotify", {})
        prov["access_token"] = access
        prov["expires_in"] = expires_in
        from datetime import datetime, timezone, timedelta
        exp = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        prov["expires_at"] = exp.isoformat()
        if tok.get("refresh_token"):
            prov["refresh_token"] = tok["refresh_token"]
        AUTH_JSON.write_text(json.dumps(data, indent=2))
    except Exception as e:
        print("[relay] spotify token persist warn", e)
    _spotify_token_cache["token"] = access
    _spotify_token_cache["exp"] = now + expires_in
    return access


def spotify_api(method: str, path: str, query: dict | None = None, body: dict | None = None) -> Any:
    token = spotify_access_token()
    base = "https://api.spotify.com/v1"
    url = base + path
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    data = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read()
            if resp.status == 204 or not raw:
                return {"ok": True, "status": resp.status}
            return json.loads(raw.decode() or "{}")
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        if e.code == 401:
            # one retry with force refresh
            token = spotify_access_token(force_refresh=True)
            headers["Authorization"] = f"Bearer {token}"
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=25) as resp:
                raw = resp.read()
                if resp.status == 204 or not raw:
                    return {"ok": True, "status": resp.status}
                return json.loads(raw.decode() or "{}")
        raise RuntimeError(f"Spotify {e.code}: {err_body[:400]}")


def itunes_preview(name: str, artists: str) -> str | None:
    """30s AAC preview the KaiOS handset can play. Spotify preview_url is often null now."""
    term = f"{name or ''} {artists or ''}".strip()
    if not term:
        return None
    try:
        qs = urllib.parse.urlencode({"term": term, "entity": "song", "limit": "3", "media": "music"})
        req = urllib.request.Request(
            "https://itunes.apple.com/search?" + qs,
            headers={"User-Agent": "PocketRelay/0.2", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode() or "{}")
        results = data.get("results") or []
        # prefer close name match
        name_l = (name or "").lower()
        for r in results:
            tn = (r.get("trackName") or "").lower()
            if name_l and name_l[:12] in tn:
                url = r.get("previewUrl")
                if url:
                    return str(url)
        for r in results:
            url = r.get("previewUrl")
            if url:
                return str(url)
    except Exception:
        return None
    return None


def music_search(q: str, limit: int = 8) -> dict:
    data = spotify_api("GET", "/search", {"q": q, "type": "track", "limit": str(limit)})
    items = ((data.get("tracks") or {}).get("items")) or []
    tracks = []
    for t in items:
        artists = ", ".join(a.get("name", "") for a in (t.get("artists") or []))
        name = t.get("name") or ""
        # Prefer Spotify preview when present; fall back to iTunes 30s clip for phone speaker
        preview = t.get("preview_url") or itunes_preview(name, artists)
        tracks.append(
            {
                "name": name,
                "artists": artists,
                "uri": t.get("uri"),
                "id": t.get("id"),
                "album": (t.get("album") or {}).get("name"),
                "preview_url": preview,
                "duration_ms": t.get("duration_ms"),
                "explicit": bool(t.get("explicit")),
                "can_play_on_phone": bool(preview),
            }
        )
    return {
        "tracks": tracks,
        "query": q,
        "play_modes": {
            "phone": "Select a track → 30s preview on handset speaker",
            "remote": "Remote → full track via Spotify Connect (TV/Mac)",
        },
    }


def music_control(action: str, uri: str | None = None, device_id: str | None = None) -> dict:
    action = (action or "").lower().strip()
    q = {}
    if device_id:
        q["device_id"] = device_id
    if action in ("play", "resume"):
        body = {}
        if uri:
            if uri.startswith("spotify:track:"):
                body = {"uris": [uri]}
            else:
                body = {"context_uri": uri}
        try:
            spotify_api("PUT", "/me/player/play", q or None, body if body else None)
        except RuntimeError as e:
            # no active device → try transfer to first available
            if "NO_ACTIVE_DEVICE" in str(e) or "404" in str(e) or "Not Found" in str(e):
                devs = spotify_api("GET", "/me/player/devices")
                devices = (devs or {}).get("devices") or []
                if not devices:
                    raise RuntimeError("No Spotify devices. Open Spotify on TV/phone/Mac first.")
                # prefer active, else first
                pick = next((d for d in devices if d.get("is_active")), devices[0])
                spotify_api("PUT", "/me/player", None, {"device_ids": [pick["id"]], "play": True})
                if uri:
                    body = {"uris": [uri]} if uri.startswith("spotify:track:") else {"context_uri": uri}
                    spotify_api("PUT", "/me/player/play", {"device_id": pick["id"]}, body if body else None)
                return {"ok": True, "action": action, "device": pick.get("name")}
            raise
        return {"ok": True, "action": action, "uri": uri}
    if action == "pause":
        spotify_api("PUT", "/me/player/pause", q or None, None)
        return {"ok": True, "action": "pause"}
    if action in ("next", "skip"):
        spotify_api("POST", "/me/player/next", q or None, None)
        return {"ok": True, "action": "next"}
    if action in ("prev", "previous"):
        spotify_api("POST", "/me/player/previous", q or None, None)
        return {"ok": True, "action": "previous"}
    if action == "devices":
        return spotify_api("GET", "/me/player/devices")
    if action in ("status", "now", "current"):
        try:
            return spotify_api("GET", "/me/player")
        except Exception as e:
            return {"ok": False, "error": str(e)}
    raise RuntimeError(f"unknown action: {action}")


def spotify_ready() -> tuple[bool, str | None]:
    try:
        sp = _load_spotify_provider()
        if not sp.get("refresh_token") and not sp.get("access_token"):
            return False, "not logged in"
        spotify_access_token()
        return True, None
    except Exception as e:
        return False, str(e)[:200]


class Handler(BaseHTTPRequestHandler):
    server_version = "PocketRelay/0.2"

    def log_message(self, fmt: str, *args) -> None:
        print("[relay]", fmt % args)

    def _auth_ok(self) -> bool:
        if self.path.startswith("/health"):
            return True
        auth = self.headers.get("Authorization", "")
        tok = self.headers.get("X-Pocket-Token", "")
        return auth == f"Bearer {TOKEN}" or tok == TOKEN

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, code: int, obj: Any) -> None:
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _raw(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Pocket-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/health":
            mini: dict[str, Any] = {}
            try:
                st, body, _ = proxy("GET", "/health", None, {})
                if st == 200:
                    mini = json.loads(body.decode() or "{}")
            except Exception as e:
                mini = {"mini_error": str(e)}
            msg_ok, msg_err = False, None
            try:
                imsg_json(["chats", "--limit", "1"])
                msg_ok = True
            except Exception as e:
                msg_err = str(e)[:300]
            hermes_ok = False
            try:
                subprocess.run([HERMES, "version"], capture_output=True, timeout=10)
                hermes_ok = True
            except Exception:
                pass
            # Reload contacts if empty (FDA may have been granted after start)
            load_contacts(force=not _CONTACT_LIST)
            out = dict(mini) if isinstance(mini, dict) else {"mini": mini}
            sp_ok, sp_err = spotify_ready()
            out.update(
                {
                    "ok": True,
                    "relay": "pocket-relay",
                    "messages_configured": True,
                    "messages_ready": msg_ok,
                    "messages_error": msg_err,
                    "hermes_configured": True,
                    "hermes_ready": hermes_ok,
                    "spotify_configured": sp_ok,
                    "spotify_ready": sp_ok,
                    "spotify_error": sp_err,
                    "contacts_loaded": len(_CONTACT_LIST),
                    "contacts_keys": len(_CONTACT_CACHE),
                    "contacts_error": _CONTACT_LOAD_ERROR,
                    "imsg": IMSG,
                }
            )
            self._json(200, out)
            return

        if not self._auth_ok():
            self._json(401, {"error": "unauthorized"})
            return

        if path in ("/v1/contacts", "/v1/contacts/search", "/v1/messages/contacts"):
            q = (qs.get("q") or qs.get("query") or qs.get("name") or [""])[0]
            try:
                limit = int((qs.get("limit") or ["40"])[0])
            except ValueError:
                limit = 40
            force = (qs.get("refresh") or [""])[0] in ("1", "true", "yes")
            try:
                if force:
                    load_contacts(force=True)
                self._json(200, search_contacts(q, limit=max(1, min(limit, 200))))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/messages/chats":
            limit = (qs.get("limit") or ["40"])[0]
            try:
                data = imsg_json(["chats", "--limit", str(limit)])
                self._json(200, {"chats": normalize_chats(data)})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/messages/history":
            chat_id = (qs.get("chat_id") or [""])[0]
            limit = (qs.get("limit") or ["80"])[0]
            if not chat_id:
                self._json(400, {"error": "chat_id required"})
                return
            try:
                data = imsg_json(["history", "--chat-id", str(chat_id), "--limit", str(limit)])
                msgs = normalize_messages(data)
                title = ""
                if msgs and msgs[-1].get("chat_name"):
                    title = msgs[-1]["chat_name"]
                self._json(200, {"messages": msgs, "title": title, "order": "chronological"})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        # Never proxy /v1/messages/* to Mini
        if path.startswith("/v1/messages"):
            self._json(404, {"error": "not found"})
            return

        if path == "/v1/music/search":
            q = (qs.get("q") or qs.get("query") or [""])[0]
            if not q:
                self._json(400, {"error": "q required"})
                return
            try:
                self._json(200, music_search(q, int((qs.get("limit") or ["8"])[0])))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path in ("/v1/music/devices", "/v1/music/status"):
            try:
                action = "devices" if path.endswith("devices") else "status"
                self._json(200, music_control(action))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/v1/music"):
            self._json(404, {"error": "not found"})
            return

        hdrs = {k: v for k, v in self.headers.items()}
        code, body, ctype = proxy("GET", self.path, None, hdrs)
        self._raw(code, body, ctype)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if not self._auth_ok():
            self._json(401, {"error": "unauthorized"})
            return

        if path == "/v1/messages/send":
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            text = (payload.get("text") or "").strip()
            to = (payload.get("to") or "").strip()
            chat_id = payload.get("chat_id")
            if not text:
                self._json(400, {"error": "text required"})
                return
            try:
                if chat_id not in (None, ""):
                    try:
                        data = imsg_json(["send", "--chat-id", str(chat_id), "--text", text])
                    except Exception:
                        if not to:
                            raise
                        data = imsg_json(["send", "--to", to, "--text", text])
                else:
                    if not to:
                        self._json(400, {"error": "to or chat_id required"})
                        return
                    data = imsg_json(["send", "--to", to, "--text", text])
                self._json(200, {"ok": True, "result": data})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/hermes":
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            prompt = (payload.get("prompt") or payload.get("message") or payload.get("text") or "").strip()
            cont = bool(payload.get("continue") or payload.get("continue_session"))
            try:
                result = run_hermes(prompt, continue_session=cont)
                self._json(200, result)
            except subprocess.TimeoutExpired:
                self._json(504, {"error": "hermes timeout"})
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/v1/messages"):
            self._json(404, {"error": "not found"})
            return

        if path in ("/v1/music/control", "/v1/music/play"):
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            action = payload.get("action") or ("play" if path.endswith("play") else "")
            uri = payload.get("uri") or payload.get("track_uri")
            device_id = payload.get("device_id")
            try:
                self._json(200, music_control(str(action), uri, device_id))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/music/search":
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            q = payload.get("q") or payload.get("query") or ""
            try:
                self._json(200, music_search(str(q), int(payload.get("limit") or 8)))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/v1/music"):
            self._json(404, {"error": "not found"})
            return

        hdrs = {k: v for k, v in self.headers.items()}
        code, resp, ctype = proxy("POST", self.path, body, hdrs)
        self._raw(code, resp, ctype)


def main() -> None:
    if not os.path.isfile(IMSG):
        raise SystemExit(f"imsg not found: {IMSG}")
    load_contacts()
    print(f"Pocket relay http://0.0.0.0:{PORT}")
    print(f"  imsg={IMSG} contacts={len(_CONTACT_CACHE)}")
    print(f"  hermes={HERMES} mini={MINI}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
