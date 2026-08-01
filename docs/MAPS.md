# B-Mud Maps (OpenStreetMap)

Private-by-default maps for the flip phone: **search + saved places + text turn-by-turn**.

## Phone UX

1. **Hub → Maps**
2. Search a place → Select a result to route  
3. Or **Save as Home / Work**, then **→ Home** / **→ Work**  
4. Scroll **Directions** steps with D-pad (like AI answer chunks)

**Origin** for routing is **Home** (or **Work** when navigating *to* Home). Set Home first.

## Relay API (Mac)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/v1/maps/search?q=&limit=` | Nominatim |
| GET | `/v1/maps/geocode?q=` | first hit |
| GET | `/v1/maps/reverse?lat=&lon=` | reverse geocode |
| GET/POST | `/v1/maps/directions` | OSRM steps |

Env overrides:

```bash
export NOMINATIM_URL=https://nominatim.openstreetmap.org
export OSRM_URL=https://router.project-osrm.org
export MAPS_USER_AGENT='B-MudTools/0.8 (your contact)'
```

Public demo servers are fine for light personal use; self-host for production.

## Privacy

- Phone never opens Google Maps  
- Queries go Mac → OSM/OSRM  
- Optional future: `GOOGLE_MAPS_API_KEY` for a Google provider toggle  
