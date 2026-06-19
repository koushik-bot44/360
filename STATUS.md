# STATUS — AI-Assisted Virtual Tour Generator

_Last updated: 2026-06-19_

This is an honest snapshot of what exists, what has been **proven end-to-end**, what is
**scaffolded but unverified**, and what is **not built yet**. It is meant to be read
alongside [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the design for the full system).

---

## 1. One-line summary

A working **360° tour builder** (Phase 1, production-quality for a student project) plus a
**local proof-of-concept reconstruction backend** (Phase 2) that turns ordinary phone photos
into an auto-generated tour graph the existing viewer can load. The Phase 2 *pipeline and
viewer integration are proven*; **real COLMAP geometry has not yet been verified on this
machine** (the binary isn't installed, so the demonstrated run used the mock-pose path).

---

## 2. What is completed and proven end-to-end

### Phase 1 — 360° Tour Builder (front-end) ✅ DONE
| Capability | Status |
|---|---|
| Upload 360° / equirectangular rooms | ✅ Working |
| Create multi-room tours | ✅ Working |
| Manual hotspot placement (turn/drag world-anchored dots) | ✅ Working |
| Multiple floors / floor selection | ✅ Working |
| Preview & play mode | ✅ Working |
| Share / link out | ✅ Working |
| **IndexedDB** storage (auto-migrates old localStorage tours, surfaces quota errors) | ✅ Working |
| Bundled real 360° demo tour | ✅ Working |

### Phase 2 — Reconstruction backend (POC) ⚠️ PIPELINE PROVEN, REAL GEOMETRY UNVERIFIED
| Component | File | Status |
|---|---|---|
| FastAPI app (create job → upload photos → reconstruct → poll → tour.json) | `backend/app/main.py` | ✅ Working |
| SQLite job store | `backend/app/db.py` | ✅ Working |
| COLMAP subprocess runner (feature → sequential match → mapper → TXT export) | `backend/app/pipeline/colmap_runner.py` | ✅ Code complete, ⚠️ binary not installed locally |
| Pose parser (`images.txt` → position + forward) | `backend/app/pipeline/poses.py` | ✅ Code complete, ⚠️ unverified on real COLMAP output |
| Mock-pose fallback (ring of viewpoints) | `backend/app/pipeline/mock.py` | ✅ Working — this is what was demonstrated |
| **Auto graph builder** (k-NN links + hotspot direction by projecting neighbour's 3D position into the camera frame) | `backend/app/pipeline/graph.py` | ✅ Working |
| Exporter → viewer-compatible `tour.json` | `backend/app/pipeline/export.py` | ✅ Working |
| Smoke test (12 synthetic photos → tour.json, no server/COLMAP) | `backend/scripts/smoke_test.py` | ✅ Working |
| Sample output | `backend/samples/sample_tour.json` (8.7 KB) | ✅ Present |
| **Viewer integration** (`builder.html?tour=<url>` fetches & renders the generated tour) | `src/builder/Builder.js`, `src/index.html` | ✅ Proven |

**Proven flow (with mock poses):**
```
phone photos → backend → poses → auto graph → tour.json → Three.js viewer → rendered
```

---

## 3. Direct answers to the key questions

| Question | Answer |
|---|---|
| **Does COLMAP successfully extract camera poses?** | **Not yet verified.** The runner + parser are written and correct on paper, but `colmap` is not installed on this machine, so every demonstrated run used the **mock** path. This is the #1 thing to validate next. |
| **Are viewpoints generated automatically?** | ✅ **Yes.** One navigation node per camera pose, no manual step. |
| **Are hotspots generated automatically?** | ✅ **Yes.** Each node links to its nearest neighbours; each hotspot direction is computed by projecting the neighbour's real 3D position into the node's camera frame — the dot literally points at the next viewpoint. |
| **Is room detection implemented?** | ❌ **No.** All nodes are treated as one space ("Ground Floor"). |
| **Is room-to-room linking implemented?** | ⚠️ **Partial.** Nodes are linked by 3D proximity (k-NN within `MAX_LINK_DIST`), but there is no concept of distinct *rooms* or doorways yet. |
| **Can a user create a tour from only phone photos?** | ⚠️ **Yes via the API end-to-end**, but (a) real geometry needs COLMAP installed, and (b) perspective photos shown on an equirectangular sphere look distorted — see limitations. |
| **What still prevents a Matterport-like experience?** | A dedicated **node-graph renderer** (photos as billboards at their 3D positions, not wrapped on a sphere), **verified real reconstruction**, **dense/mesh geometry**, **room segmentation**, a **dollhouse/floorplan view**, and **measurement**. |

---

## 4. Current limitations (honest)

1. **Mock path ≠ reconstruction.** The ring layout fakes geometry to make the integration
   visible. Real positions require COLMAP (or `hloc`) — install it to validate.
2. **Perspective photos in an equirectangular viewer look distorted** (the "PHOTO 1"
   stretching seen in testing). The POC proves the *pose → graph → hotspot* automation, not
   final visual fidelity. A node-graph renderer is the right fix.
3. **Indoor low-texture rooms can defeat classic COLMAP** feature matching. `hloc`
   (SuperPoint + SuperGlue) is the documented upgrade — see `ARCHITECTURE.md §7`.
4. **Single-process background tasks**, no real job queue. Fine for one user / one job; not
   for concurrent load.
5. **No accounts, auth, billing, or cloud** — by design; this is a local POC.

---

## 5. Maturity scorecard

| Track | Completeness |
|---|---|
| MVP 360° Tour Builder | **100%** |
| COLMAP reconstruction (code) | **70%** — written, not yet run on real photos |
| Automatic tour generation (poses → graph → hotspots) | **60%** — works on mock; awaits real-geometry validation |
| Matterport-like experience | **~10%** |

---

## 6. Immediate next steps (to close Phase 2 honestly)

1. **Install COLMAP** (`brew install colmap`) and run the API on a real 20–30 photo set of
   one room. Confirm `poses.py` parses `images.txt` and the graph looks sane.
2. **Add a node-graph renderer** to the viewer: show each photo as a billboard at its 3D
   position instead of wrapping it on a sphere. This removes the distortion and is the single
   biggest visual-quality win.
3. **Capture two screenshots** (mock tour + first real COLMAP tour) and drop them here.

---

## 7. Roadmap

### Phase 3 — AR-guided capture
- Browser AR (WebXR) overlay that guides the user to capture points and ensures enough
  overlap between shots (the main cause of COLMAP failures).
- Live coverage feedback ("you've covered ~70% of this room").
- On-device blur/exposure rejection before upload.

### Phase 4 — Automatic room segmentation & linking
- Cluster camera poses into **rooms**; detect doorways as links between clusters.
- Auto-generate a **floorplan** from the sparse/dense point cloud.
- Replace the flat "Ground Floor" label with real per-room nodes and room-to-room hotspots.

### Phase 5 — NeRF / Gaussian Splatting
- Dense photoreal reconstruction (3D Gaussian Splatting) for free-viewpoint navigation
  instead of discrete nodes.
- Dollhouse / orbit view and measurement tools (true Matterport-class features).
- This is the research-heavy frontier; gate it behind a validated Phase 2 + 4.

---

## 8. How to run (quick reference)

```bash
# Front-end (Phase 1)
npm run start                      # http://localhost:3000

# Backend (Phase 2) — runs without COLMAP via the mock path
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/smoke_test.py       # writes samples/sample_tour.json
uvicorn app.main:app --reload --port 8000

# See a generated tour in the viewer
# http://localhost:3000/builder.html?tour=http://localhost:8000/tours/<JID>/tour.json
```

See `backend/README.md` for the full API and `ARCHITECTURE.md` for the system design.
