# B-Mud Podcasts (free RSS)

Listen to **public podcast RSS feeds** on the flip — no store, no account, no Spotify Premium required.

## Phone

**Hub → Podcasts**

1. **Browse free shows** (curated catalog on the Mac relay)
2. Select a show → episode list
3. Select episode → plays on the handset speaker
4. **Subscribe** saves the feed locally
5. Paste any `https://…/podcast.xml` URL under custom feed

Audio streams through the Mac proxy (`/v1/podcasts/proxy`) so tracking redirects and picky CDNs still work.

## Relay API

| Method | Path |
|--------|------|
| GET | `/v1/podcasts/catalog` |
| GET | `/v1/podcasts/feed?url=&limit=` |
| GET | `/v1/podcasts/proxy?url=&token=` |

## Notes

- Catalog is curated free public feeds (NPR, TED, etc.) — edit `PODCAST_CATALOG` in the relay to taste.
- Respect show bandwidth; this is for personal use.
- Phone must reach the Mac; Mac needs outbound HTTPS to feed hosts / CDNs.
