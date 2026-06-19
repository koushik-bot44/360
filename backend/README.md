# Phase 2 — Reconstruction backend (local proof of concept)

Turns **ordinary phone photos** into an **automatically generated tour** that the
existing Three.js viewer can load — no manual hotspots, no panoramas.

```
10–30 phone photos
      ↓  COLMAP Structure-from-Motion  (or mock poses if COLMAP not installed)
camera poses (position + orientation)
      ↓  graph builder
navigation nodes + AUTO-generated hotspots  (dot = projected 3D position of the next viewpoint)
      ↓  exporter
tour.json  →  loadable by the existing viewer at  /builder.html?tour=<url>
```

This is a **local POC**. No accounts, billing, auth, or cloud — just the smallest
end-to-end system that proves the pipeline. The front-end is unchanged.

## Real reconstruction is verified ✅
The default engine is **pycolmap** (COLMAP as a pip wheel — no system install).
On a synthetic room with known ground-truth poses, it recovered **20/20 camera
positions with RMSE 0.5% of the ring radius** (`python scripts/colmap_test.py`).
If neither pycolmap nor a `colmap` CLI binary is present, the pipeline falls back
to a **mock-pose** path so the whole flow — upload → graph → tour.json → viewer —
is still demonstrable; everything downstream is identical.

## Capture geometry matters more than the engine
The two things that make or break reconstruction (learned the hard way during
verification):
- **Parallax** — the camera must *translate* between shots. Tiny rings / near-pure
  rotation are panoramic-degenerate and collapse all cameras to one point.
- **Shared structure** — neighbouring photos must see the *same* surfaces. Cameras
  looking **across** a room (object-centric) reconstruct cleanly; cameras looking
  **outward** at disjoint walls do not. This directly informs Phase 3 AR-capture
  guidance.

## Setup
```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# optional, for real reconstruction:
#   brew install colmap        # macOS
#   apt install colmap         # ubuntu
```

## Verify (no server, no COLMAP)
```bash
python scripts/smoke_test.py
# → creates 12 test photos, runs the flow, writes samples/sample_tour.json
```

## Run the API
```bash
uvicorn app.main:app --reload --port 8000
```

| Endpoint | Purpose |
|---|---|
| `POST /tours` | create a job (`{"title": "..."}`) |
| `POST /tours/{id}/photos` | upload photos (multipart `files`) |
| `POST /tours/{id}/reconstruct` | run pose estimation + graph (background) |
| `GET  /tours/{id}` | status (+ `tour_url` when ready) |
| `GET  /tours/{id}/tour.json` | the generated tour |
| `GET  /health` | reports whether COLMAP is available |

### Example
```bash
JID=$(curl -s -X POST localhost:8000/tours -H 'Content-Type: application/json' \
      -d '{"title":"My Room"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST localhost:8000/tours/$JID/photos \
     $(for f in shots/*.jpg; do echo -F "files=@$f"; done) > /dev/null
curl -s -X POST localhost:8000/tours/$JID/reconstruct > /dev/null
curl -s localhost:8000/tours/$JID          # poll until "ready"
```

## See it in the viewer
With the front-end dev server running (`npm run start`, port 3000) and the API on
port 8000:

```
http://localhost:3000/builder.html?tour=http://localhost:8000/tours/<JID>/tour.json
```

The viewer fetches the auto-generated `tour.json` and lets you walk the nodes via
the auto-created hotspots.

## Scripts
| Script | What it does |
|---|---|
| `scripts/make_synthetic_room.py [dir] [n]` | render a textured room from a ring of cameras (+ ground-truth poses) |
| `scripts/colmap_test.py` | run the real engine and check recovered poses vs. ground truth (RMSE) |
| `scripts/real_tour_demo.py` | full pipeline on real reconstruction → `samples/sample_tour_colmap.json` |
| `scripts/smoke_test.py` | fast end-to-end check (mock path, no COLMAP needed) |

## Honest limitations (POC)
- **Mock path is not reconstruction** — it fakes a ring layout so the integration
  is visible when no real engine is installed.
- **Perspective-photo distortion is fixed in the viewer**: auto-generated tours
  (`_meta.generated`) now render each photo on a flat billboard (the node-graph
  renderer) instead of wrapping it on a sphere. See `src/builder/PanoViewer.js`.
- Indoor low-texture rooms can defeat classic COLMAP matching; `hloc`
  (SuperPoint+SuperGlue) is the documented upgrade (see ../ARCHITECTURE.md §7).
- Single-process background tasks (no queue) — fine for one user, one job.
