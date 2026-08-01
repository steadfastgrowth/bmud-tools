#!/usr/bin/env python3
"""Pocket relay: iMessage (imsg) + Hermes agent + proxy AI/STT to Mini.

PRIVACY:
  /v1/messages/*  → local imsg ONLY (never Mini/Grok)
  /v1/hermes      → local hermes CLI on this Mac
  /v1/music/*     → Spotify Connect on this Mac (Hermes tokens)
  /v1/maps/*      → OpenStreetMap (Nominatim + OSRM)
  /v1/term/*      → SSH to Tailscale hosts (Mac keys)
  /v1/podcasts/*  → free RSS podcast feeds + optional audio proxy
  other routes    → Mini bridge (Grok/Whisper)

  export POCKET_TOKEN=...
  export MINI_BRIDGE=http://192.168.1.78:8787
  export IMSG_BIN=~/Downloads/imsg-bin/imsg
  export HERMES_BIN=hermes
  python3 pocket_imsg_relay.py
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


# --- Maps (OpenStreetMap: Nominatim + OSRM) — private by default, no Google ---
NOMINATIM = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org").rstrip("/")
OSRM = os.environ.get("OSRM_URL", "https://router.project-osrm.org").rstrip("/")
MAPS_UA = os.environ.get("MAPS_USER_AGENT", "B-MudTools/0.8 (KaiOS flip; personal use)")


def _http_json(url: str, timeout: int = 20) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": MAPS_UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def maps_search(q: str, limit: int = 8, near_lat: float | None = None, near_lon: float | None = None) -> dict:
    q = (q or "").strip()
    if not q:
        raise ValueError("q required")
    params: dict[str, str] = {
        "q": q,
        "format": "json",
        "addressdetails": "1",
        "limit": str(max(1, min(limit, 15))),
    }
    if near_lat is not None and near_lon is not None:
        # bias: viewbox ~0.3 deg around point
        d = 0.25
        params["viewbox"] = f"{near_lon-d},{near_lat+d},{near_lon+d},{near_lat-d}"
        params["bounded"] = "0"
    url = NOMINATIM + "/search?" + urllib.parse.urlencode(params)
    raw = _http_json(url)
    places = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        lat = item.get("lat")
        lon = item.get("lon")
        if lat is None or lon is None:
            continue
        name = item.get("name") or (item.get("display_name") or "").split(",")[0]
        places.append(
            {
                "name": name,
                "address": item.get("display_name") or "",
                "lat": float(lat),
                "lon": float(lon),
                "type": item.get("type") or item.get("class") or "",
                "osm_id": item.get("osm_id"),
            }
        )
    return {"places": places, "query": q, "provider": "nominatim", "count": len(places)}


def maps_geocode(q: str) -> dict:
    r = maps_search(q, limit=1)
    places = r.get("places") or []
    if not places:
        raise ValueError("place not found: " + q)
    return places[0]


def maps_reverse(lat: float, lon: float) -> dict:
    params = {"lat": str(lat), "lon": str(lon), "format": "json", "addressdetails": "1"}
    url = NOMINATIM + "/reverse?" + urllib.parse.urlencode(params)
    item = _http_json(url)
    if not isinstance(item, dict) or item.get("error"):
        raise ValueError(str((item or {}).get("error") or "reverse geocode failed"))
    return {
        "name": item.get("name") or (item.get("display_name") or "").split(",")[0],
        "address": item.get("display_name") or "",
        "lat": float(item.get("lat") or lat),
        "lon": float(item.get("lon") or lon),
        "provider": "nominatim",
    }


def _resolve_point(obj: Any, label: str) -> dict:
    """Accept {lat,lon} or {q} or string."""
    if obj is None:
        raise ValueError(f"{label} required")
    if isinstance(obj, str):
        return maps_geocode(obj)
    if not isinstance(obj, dict):
        raise ValueError(f"invalid {label}")
    if obj.get("lat") is not None and obj.get("lon") is not None:
        return {
            "name": obj.get("name") or label,
            "address": obj.get("address") or "",
            "lat": float(obj["lat"]),
            "lon": float(obj["lon"]),
        }
    q = obj.get("q") or obj.get("query") or obj.get("address") or obj.get("name")
    if q:
        p = maps_geocode(str(q))
        if obj.get("name"):
            p["name"] = obj["name"]
        return p
    raise ValueError(f"{label} needs lat/lon or q")


def maps_directions(
    origin: Any,
    destination: Any,
    mode: str = "driving",
) -> dict:
    mode = (mode or "driving").lower().strip()
    if mode not in ("driving", "walking", "cycling"):
        mode = "driving"
    o = _resolve_point(origin, "from")
    d = _resolve_point(destination, "to")
    # OSRM: lon,lat
    profile = {"driving": "driving", "walking": "walking", "cycling": "cycling"}[mode]
    coords = f"{o['lon']},{o['lat']};{d['lon']},{d['lat']}"
    url = (
        f"{OSRM}/route/v1/{profile}/{coords}"
        f"?overview=false&steps=true&annotations=false"
    )
    data = _http_json(url, timeout=30)
    if data.get("code") != "Ok":
        raise RuntimeError(data.get("message") or data.get("code") or "routing failed")
    routes = data.get("routes") or []
    if not routes:
        raise RuntimeError("no route")
    route = routes[0]
    legs = route.get("legs") or []
    steps_out = []
    n = 0
    for leg in legs:
        for step in leg.get("steps") or []:
            man = step.get("maneuver") or {}
            instruction = step.get("name") or ""
            mtype = man.get("type") or ""
            modifier = man.get("modifier") or ""
            # Humanize
            if mtype == "depart":
                text = "Start on " + (instruction or "road")
            elif mtype == "arrive":
                text = "Arrive at destination"
            elif mtype == "turn":
                text = f"Turn {modifier} onto {instruction}".strip()
            elif mtype == "new name":
                text = f"Continue on {instruction}".strip()
            elif mtype == "merge":
                text = f"Merge {modifier} onto {instruction}".strip()
            elif mtype == "roundabout":
                text = f"Roundabout {modifier} to {instruction}".strip()
            elif mtype == "end of road":
                text = f"At end of road, turn {modifier} onto {instruction}".strip()
            elif mtype == "fork":
                text = f"Keep {modifier} at fork onto {instruction}".strip()
            elif mtype == "continue":
                text = f"Continue on {instruction}".strip()
            else:
                text = (mtype + " " + modifier + " " + instruction).strip()
            dist_m = float(step.get("distance") or 0)
            dur_s = float(step.get("duration") or 0)
            n += 1
            steps_out.append(
                {
                    "i": n,
                    "text": text,
                    "distance_m": round(dist_m),
                    "duration_s": round(dur_s),
                    "distance": _fmt_dist(dist_m),
                    "duration": _fmt_dur(dur_s),
                }
            )
    total_m = float(route.get("distance") or 0)
    total_s = float(route.get("duration") or 0)
    return {
        "provider": "osrm",
        "mode": mode,
        "from": o,
        "to": d,
        "distance_m": round(total_m),
        "duration_s": round(total_s),
        "distance": _fmt_dist(total_m),
        "duration": _fmt_dur(total_s),
        "steps": steps_out,
        "step_count": len(steps_out),
    }


def _fmt_dist(m: float) -> str:
    if m < 1000:
        return f"{int(round(m))} m"
    mi = m / 1609.344
    if mi < 10:
        return f"{mi:.1f} mi"
    return f"{mi:.0f} mi"


def _fmt_dur(s: float) -> str:
    s = int(round(s))
    if s < 60:
        return f"{s}s"
    mins = s // 60
    if mins < 60:
        return f"{mins} min"
    h = mins // 60
    m = mins % 60
    return f"{h}h {m}m"


def maps_ready() -> tuple[bool, str | None]:
    try:
        # light check — don't hammer APIs
        return True, None
    except Exception as e:
        return False, str(e)[:200]



# --- Terminal / SSH (any Tailscale host the Mac can reach) ---
TAILSCALE_BIN = os.environ.get("TAILSCALE_BIN", "tailscale")
SSH_BIN = os.environ.get("SSH_BIN", "ssh")
TERM_DEFAULT_USER = os.environ.get("TERM_SSH_USER") or os.environ.get("USER") or "user"
TERM_MAX_OUTPUT = int(os.environ.get("TERM_MAX_OUTPUT", "120000"))
TERM_DEFAULT_TIMEOUT = int(os.environ.get("TERM_TIMEOUT", "60"))


def term_hosts() -> dict:
    """List self + peers from `tailscale status --json`."""
    hosts = []
    try:
        p = subprocess.run(
            [TAILSCALE_BIN, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if p.returncode != 0:
            raise RuntimeError((p.stderr or p.stdout or "tailscale status failed").strip())
        data = json.loads(p.stdout or "{}")
    except FileNotFoundError:
        raise RuntimeError("tailscale CLI not found on Mac")
    except Exception as e:
        raise RuntimeError(str(e))

    def add_node(node: dict, is_self: bool = False) -> None:
        if not node:
            return
        ips = node.get("TailscaleIPs") or []
        ip4 = next((ip for ip in ips if ":" not in ip), None)
        ip6 = next((ip for ip in ips if ":" in ip), None)
        dns = (node.get("DNSName") or "").rstrip(".")
        host = node.get("HostName") or (dns.split(".")[0] if dns else "")
        online = bool(node.get("Online")) if not is_self else True
        if is_self:
            online = True
        os_name = ""
        try:
            os_name = (node.get("OS") or "") or ""
        except Exception:
            pass
        hosts.append(
            {
                "name": host or dns or ip4 or "node",
                "dns": dns,
                "ip": ip4 or ip6 or "",
                "ips": ips,
                "online": online,
                "os": os_name,
                "self": is_self,
                "target": ip4 or dns or host,
            }
        )

    add_node(data.get("Self") or {}, is_self=True)
    peers = data.get("Peer") or {}
    if isinstance(peers, dict):
        for _k, node in peers.items():
            add_node(node or {}, is_self=False)
    # online first, then name
    hosts.sort(key=lambda h: (0 if h.get("online") else 1, (h.get("name") or "").lower()))
    return {
        "hosts": hosts,
        "count": len(hosts),
        "default_user": TERM_DEFAULT_USER,
        "provider": "tailscale+ssh",
    }


def _is_local_host(host: str) -> bool:
    h = (host or "").strip().lower()
    if h in ("local", "localhost", "127.0.0.1", "::1", "self", "this", "mac"):
        return True
    try:
        st = term_hosts()
        for node in st.get("hosts") or []:
            if not node.get("self"):
                continue
            names = {
                (node.get("name") or "").lower(),
                (node.get("dns") or "").lower(),
                (node.get("ip") or "").lower(),
                (node.get("target") or "").lower(),
            }
            for ip in node.get("ips") or []:
                names.add(str(ip).lower())
            if h in names or h.rstrip(".") in names:
                return True
    except Exception:
        pass
    return False


def term_exec(
    host: str,
    command: str,
    user: str | None = None,
    port: int | None = None,
    timeout: int | None = None,
) -> dict:
    """Run a command on a Tailnet host via SSH, or locally if host is this Mac.

    Local (no sshd required): host = local | localhost | self | this Mac's TS IP/name.
    Remote: uses the Mac's SSH keys/agent (BatchMode — keys required, no password prompt).
    """
    host = (host or "").strip()
    command = (command or "").strip()
    if not host:
        raise ValueError("host required")
    if not command:
        raise ValueError("command required")
    if any(c in host for c in " ;|&$`()<>\"\'"):
        raise ValueError("invalid host")
    user = (user or TERM_DEFAULT_USER or "").strip() or TERM_DEFAULT_USER
    if user and any(c in user for c in " ;|&$`()<>\"\'"):
        raise ValueError("invalid user")
    timeout = int(timeout or TERM_DEFAULT_TIMEOUT)
    timeout = max(5, min(timeout, 300))
    t0 = time.time()

    # --- local shell on the relay Mac ---
    if _is_local_host(host):
        shell = os.environ.get("SHELL") or "/bin/zsh"
        try:
            p = subprocess.run(
                [shell, "-lc", command],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            out = e.stdout if isinstance(e.stdout, str) else ""
            err = e.stderr if isinstance(e.stderr, str) else "timeout"
            return {
                "ok": False,
                "host": host,
                "user": user,
                "command": command,
                "mode": "local",
                "exit_code": None,
                "stdout": (out or "")[:TERM_MAX_OUTPUT],
                "stderr": (err or "timeout")[:8000],
                "elapsed_s": round(time.time() - t0, 2),
                "error": f"timeout after {timeout}s",
            }
        stdout = (p.stdout or "")[:TERM_MAX_OUTPUT]
        stderr = (p.stderr or "")[:8000]
        return {
            "ok": p.returncode == 0,
            "host": host,
            "user": user,
            "command": command,
            "mode": "local",
            "exit_code": p.returncode,
            "stdout": stdout,
            "stderr": stderr,
            "elapsed_s": round(time.time() - t0, 2),
            "truncated": len(p.stdout or "") > TERM_MAX_OUTPUT,
        }

    # --- remote SSH ---
    target = f"{user}@{host}" if user else host
    cmd = [
        SSH_BIN,
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=12",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=2",
        "-o", "StrictHostKeyChecking=accept-new",
    ]
    if port:
        cmd.extend(["-p", str(int(port))])
    cmd.extend([target, command])

    t0 = time.time()
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or "") if isinstance(e.stdout, str) else ""
        err = (e.stderr or "") if isinstance(e.stderr, str) else "timeout"
        return {
            "ok": False,
            "host": host,
            "user": user,
            "command": command,
            "exit_code": None,
            "stdout": (out or "")[:TERM_MAX_OUTPUT],
            "stderr": (err or "timeout")[:8000],
            "elapsed_s": round(time.time() - t0, 2),
            "error": f"timeout after {timeout}s",
        }
    except FileNotFoundError:
        raise RuntimeError("ssh not found on Mac")
    stdout = (p.stdout or "")[:TERM_MAX_OUTPUT]
    stderr = (p.stderr or "")[:8000]
    return {
        "ok": p.returncode == 0,
        "host": host,
        "user": user,
        "command": command,
        "mode": "ssh",
        "exit_code": p.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "elapsed_s": round(time.time() - t0, 2),
        "truncated": len(p.stdout or "") > TERM_MAX_OUTPUT,
    }



# --- Podcasts (free RSS / enclosures) ---
import xml.etree.ElementTree as ET

PODCAST_UA = os.environ.get("PODCAST_USER_AGENT", "B-MudTools/0.9 (KaiOS; personal podcast client)")
PODCAST_MAX_EPISODES = int(os.environ.get("PODCAST_MAX_EPISODES", "30"))

# Curated free public RSS feeds (no login)
PODCAST_CATALOG = [
    {"id": "planet-money", "title": "Planet Money", "author": "NPR",
     "url": "https://feeds.npr.org/510289/podcast.xml"},
    {"id": "npr-news-now", "title": "NPR News Now", "author": "NPR",
     "url": "https://feeds.npr.org/500005/podcast.xml"},
    {"id": "up-first", "title": "Up First", "author": "NPR",
     "url": "https://feeds.npr.org/510318/podcast.xml"},
    {"id": "ted-talks-daily", "title": "TED Talks Daily", "author": "TED",
     "url": "https://feeds.feedburner.com/TEDTalks_audio"},
    {"id": "freakonomics", "title": "Freakonomics Radio", "author": "Freakonomics",
     "url": "https://feeds.simplecast.com/Y8lFbOT4"},
    {"id": "reply-all", "title": "Reply All (archive)", "author": "Gimlet",
     "url": "https://feeds.simplecast.com/4T39_jAj"},
    {"id": "this-american-life", "title": "This American Life", "author": "TAL",
     "url": "https://www.thisamericanlife.org/podcast/rss.xml"},
    {"id": "99pi", "title": "99% Invisible", "author": "Roman Mars",
     "url": "https://feeds.simplecast.com/BqbsxVfO"},
]


def _strip_html(s: str) -> str:
    s = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", s or "")
    s = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _xml_text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return (el.text or "").strip()


def _find_text(parent: ET.Element, names: list[str]) -> str:
    for n in names:
        el = parent.find(n)
        if el is not None and (el.text or "").strip():
            return (el.text or "").strip()
        # namespaced tag endswith
        for child in parent:
            tag = child.tag.split("}")[-1] if isinstance(child.tag, str) else ""
            if tag == n and (child.text or "").strip():
                return (child.text or "").strip()
    return ""


def podcasts_catalog() -> dict:
    return {"feeds": PODCAST_CATALOG, "count": len(PODCAST_CATALOG), "provider": "rss"}


def podcasts_parse_feed(feed_url: str, limit: int | None = None) -> dict:
    feed_url = (feed_url or "").strip()
    if not feed_url.startswith("http://") and not feed_url.startswith("https://"):
        raise ValueError("feed url must be http(s)")
    limit = int(limit or PODCAST_MAX_EPISODES)
    limit = max(1, min(limit, 50))
    req = urllib.request.Request(
        feed_url,
        headers={"User-Agent": PODCAST_UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        raw = resp.read()
        final_url = resp.geturl()
    # strip default ns for easier parsing
    root = ET.fromstring(raw)
    channel = root.find("channel")
    if channel is None:
        # sometimes namespaced
        for el in root.iter():
            if isinstance(el.tag, str) and el.tag.endswith("channel"):
                channel = el
                break
    if channel is None:
        raise RuntimeError("not a valid RSS podcast feed")

    title = _find_text(channel, ["title"]) or "Podcast"
    desc = _strip_html(_find_text(channel, ["description", "summary"]))
    author = _find_text(channel, ["author", "creator"]) or ""
    link = _find_text(channel, ["link"]) or final_url

    items = []
    for child in list(channel):
        tag = child.tag.split("}")[-1] if isinstance(child.tag, str) else ""
        if tag != "item":
            continue
        it_title = _find_text(child, ["title"]) or "Episode"
        it_desc = _strip_html(_find_text(child, ["description", "summary", "subtitle"]))
        pub = _find_text(child, ["pubDate", "date"])
        duration = _find_text(child, ["duration"])
        # enclosure
        enc_url = ""
        enc_type = ""
        enc_len = 0
        for enc in child:
            et = enc.tag.split("}")[-1] if isinstance(enc.tag, str) else ""
            if et == "enclosure":
                enc_url = enc.attrib.get("url") or ""
                enc_type = enc.attrib.get("type") or ""
                try:
                    enc_len = int(enc.attrib.get("length") or 0)
                except ValueError:
                    enc_len = 0
                break
        if not enc_url:
            # media:content
            for enc in child:
                et = enc.tag.split("}")[-1] if isinstance(enc.tag, str) else ""
                if et == "content" and enc.attrib.get("url"):
                    enc_url = enc.attrib.get("url") or ""
                    enc_type = enc.attrib.get("type") or "audio/mpeg"
                    break
        if not enc_url:
            continue
        items.append(
            {
                "title": it_title,
                "description": it_desc[:500],
                "pub_date": pub,
                "duration": duration,
                "audio_url": enc_url,
                "audio_type": enc_type or "audio/mpeg",
                "audio_bytes": enc_len,
            }
        )
        if len(items) >= limit:
            break

    return {
        "title": title,
        "description": desc[:800],
        "author": author,
        "link": link,
        "feed_url": feed_url,
        "episodes": items,
        "count": len(items),
        "provider": "rss",
    }


def podcasts_proxy_headers(audio_url: str) -> tuple[str, dict[str, str]]:
    """HEAD/GET probe for content-type (not full body)."""
    audio_url = (audio_url or "").strip()
    if not audio_url.startswith("http"):
        raise ValueError("invalid audio url")
    req = urllib.request.Request(
        audio_url,
        method="HEAD",
        headers={"User-Agent": PODCAST_UA},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            ctype = resp.headers.get("Content-Type") or "audio/mpeg"
            return resp.geturl(), {"Content-Type": ctype, "Content-Length": resp.headers.get("Content-Length") or ""}
    except Exception:
        return audio_url, {"Content-Type": "audio/mpeg"}



class Handler(BaseHTTPRequestHandler):
    server_version = "PocketRelay/0.2"

    def log_message(self, fmt: str, *args) -> None:
        print("[relay]", fmt % args)

    def _auth_ok(self) -> bool:
        if self.path.startswith("/health"):
            return True
        # audio <audio src> cannot set headers — allow token query on podcast proxy only
        if "/v1/podcasts/proxy" in (self.path or "") and TOKEN:
            try:
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                if (q.get("token") or [""])[0] == TOKEN:
                    return True
            except Exception:
                pass
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
                    "maps_ready": True,
                    "maps_provider": "osm",
                    "term_ready": True,
                    "term_provider": "tailscale+ssh",
                    "podcasts_ready": True,
                    "podcasts_provider": "rss",
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




        if path in ("/v1/podcasts/catalog", "/v1/podcasts/feeds"):
            self._json(200, podcasts_catalog())
            return

        if path in ("/v1/podcasts/feed", "/v1/podcasts/episodes"):
            url = (qs.get("url") or qs.get("feed") or [""])[0]
            if not url:
                self._json(400, {"error": "url required"})
                return
            try:
                limit = int((qs.get("limit") or [str(PODCAST_MAX_EPISODES)])[0])
            except ValueError:
                limit = PODCAST_MAX_EPISODES
            try:
                self._json(200, podcasts_parse_feed(url, limit))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/podcasts/proxy":
            # Stream audio through the Mac (chunked; helps tracking redirects / UA issues)
            audio_url = (qs.get("url") or [""])[0]
            if not audio_url.startswith("http"):
                self._json(400, {"error": "url required"})
                return
            try:
                req = urllib.request.Request(
                    audio_url,
                    headers={"User-Agent": PODCAST_UA, "Accept": "*/*"},
                )
                with urllib.request.urlopen(req, timeout=120) as resp:
                    ctype = resp.headers.get("Content-Type") or "audio/mpeg"
                    clen = resp.headers.get("Content-Length")
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    if clen:
                        self.send_header("Content-Length", clen)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Cache-Control", "private, max-age=600")
                    self.end_headers()
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            except Exception as e:
                try:
                    self._json(502, {"error": str(e)})
                except Exception:
                    pass
            return

        if path.startswith("/v1/podcasts"):
            self._json(404, {"error": "not found"})
            return

        if path in ("/v1/term/hosts", "/v1/terminal/hosts"):
            try:
                self._json(200, term_hosts())
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/v1/term") or path.startswith("/v1/terminal"):
            self._json(404, {"error": "not found"})
            return

        if path in ("/v1/maps/search", "/v1/maps/geocode"):
            q = (qs.get("q") or qs.get("query") or [""])[0]
            if not q:
                self._json(400, {"error": "q required"})
                return
            try:
                limit = int((qs.get("limit") or ["8"])[0])
            except ValueError:
                limit = 8
            near_lat = near_lon = None
            try:
                if qs.get("near_lat"):
                    near_lat = float(qs.get("near_lat")[0])
                if qs.get("near_lon"):
                    near_lon = float(qs.get("near_lon")[0])
            except ValueError:
                pass
            try:
                if path.endswith("geocode"):
                    self._json(200, maps_geocode(q))
                else:
                    self._json(200, maps_search(q, limit, near_lat, near_lon))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/maps/reverse":
            try:
                lat = float((qs.get("lat") or [""])[0])
                lon = float((qs.get("lon") or [""])[0])
                self._json(200, maps_reverse(lat, lon))
            except Exception as e:
                self._json(400, {"error": str(e)})
            return

        if path == "/v1/maps/directions":
            # GET convenience: from_q / to_q
            try:
                mode = (qs.get("mode") or ["driving"])[0]
                if qs.get("from_lat") and qs.get("to_lat"):
                    origin = {"lat": float(qs["from_lat"][0]), "lon": float(qs["from_lon"][0])}
                    dest = {"lat": float(qs["to_lat"][0]), "lon": float(qs["to_lon"][0])}
                else:
                    origin = (qs.get("from") or qs.get("from_q") or [""])[0]
                    dest = (qs.get("to") or qs.get("to_q") or [""])[0]
                self._json(200, maps_directions(origin, dest, mode))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path.startswith("/v1/maps"):
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



        if path in ("/v1/term/exec", "/v1/terminal/exec", "/v1/term/run"):
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            try:
                host = payload.get("host") or payload.get("target") or ""
                command = payload.get("command") or payload.get("cmd") or payload.get("q") or ""
                user = payload.get("user")
                port = payload.get("port")
                timeout = payload.get("timeout")
                self._json(200, term_exec(str(host), str(command), user, port, timeout))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path in ("/v1/maps/directions", "/v1/maps/route"):
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            try:
                origin = payload.get("from") or payload.get("origin")
                dest = payload.get("to") or payload.get("destination")
                mode = payload.get("mode") or "driving"
                self._json(200, maps_directions(origin, dest, str(mode)))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        if path == "/v1/maps/search":
            try:
                payload = json.loads(body.decode() or "{}")
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            try:
                q = payload.get("q") or payload.get("query") or ""
                limit = int(payload.get("limit") or 8)
                near_lat = payload.get("near_lat")
                near_lon = payload.get("near_lon")
                if near_lat is not None:
                    near_lat = float(near_lat)
                if near_lon is not None:
                    near_lon = float(near_lon)
                self._json(200, maps_search(str(q), limit, near_lat, near_lon))
            except Exception as e:
                self._json(500, {"error": str(e)})
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
