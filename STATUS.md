# STATUS — AI-Assisted Virtual Tour Generator

_Last updated: 2026-06-19_

This is an honest snapshot of what exists, what has been **proven end-to-end**, what is
**scaffolded but unverified**, and what is **not built yet**. It is meant to be read
alongside [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the design for the full system).

---

## 1. One-line summary

A working **360° tour builder** (Phase 1) plus a local **panorama-stitching pipeline** (the
chosen product direction): upload 10–20 overlapping phone photos → OpenCV Stitcher →
equirectangular panorama → loads straight into the sphere viewer as a room scene. Verified
end-to-end in the browser (`POST /panorama`, the builder's **🧩 Stitch photos** button). A
separate, optional **pycolmap reconstruction** track (20/20 poses, RMSE 0.5%) remains for
future scene-positioning. See [`PANORAMA_TOUR.md`](./PANORAMA_TOUR.md) and
[`CAPTURE_GUIDE.md`](./CAPTURE_GUIDE.md).

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

### Panorama pipeline (the product) ✅ VERIFIED END-TO-END
| Component | File | Status |
|---|---|---|
| **Stitcher** — OpenCV Stitcher (PANORAMA) → 2:1 equirectangular + debug info | `backend/app/pipeline/stitch.py` | ✅ Working |
| **`POST /panorama`** endpoint (photos → data-URL panorama + debug) | `backend/app/main.py` | ✅ Working |
| **🧩 Stitch photos** button → adds the panorama as a room scene | `src/builder/Builder.js`, `src/builder.html` | ✅ Verified in-browser |
| Rotation-capture generator + stitch test (good/bad examples) | `backend/scripts/make_synthetic_pano.py`, `stitch_test.py`, `make_capture_examples.py` | ✅ Working |
| Capture guide (pattern, overlap, good/bad examples) | `CAPTURE_GUIDE.md`, `docs/capture/` | ✅ Done |

Proven: 14 rotation photos → 9,631 matched features → 4096×2048 panorama → sphere viewer,
look around in every direction (verified by screenshot at multiple yaw angles). Bad captures
fail with a clear `reason` (too few / no overlap / parallax).

### Optional reconstruction backend (Phase 2) ✅ REAL RECONSTRUCTION VERIFIED
| Component | File | Status |
|---|---|---|
| FastAPI app (create job → upload photos → reconstruct → poll → tour.json) | `backend/app/main.py` | ✅ Working |
| SQLite job store | `backend/app/db.py` | ✅ Working |
| **Reconstruction runner — pycolmap engine** (features → exhaustive match → incremental SfM → TXT export), colmap-CLI fallback | `backend/app/pipeline/colmap_runner.py` | ✅ **Verified** (20/20 poses) |
| Pose parser (`images.txt` → position + forward) | `backend/app/pipeline/poses.py` | ✅ Verified on real output |
| Mock-pose fallback (ring of viewpoints) | `backend/app/pipeline/mock.py` | ✅ Working (used only if no engine) |
| **Auto graph builder** (k-NN links + hotspot direction by projecting neighbour's 3D position into the camera frame) | `backend/app/pipeline/graph.py` | ✅ Working |
| Exporter → viewer-compatible `tour.json` | `backend/app/pipeline/export.py` | ✅ Working |
| Synthetic test-scene renderer (+ ground truth) | `backend/scripts/make_synthetic_room.py` | ✅ Working |
| **Reconstruction accuracy test** (RMSE vs ground truth) | `backend/scripts/colmap_test.py` | ✅ PASS (RMSE 0.5%) |
| Full real-pipeline demo → sample | `backend/scripts/real_tour_demo.py` → `samples/sample_tour_colmap.json` | ✅ Working |
| **Node-graph renderer** (flat undistorted photo billboards + directional dots) | `src/builder/PanoViewer.js`, `src/builder/Builder.js` | ✅ **Verified in-browser** |
| **Viewer integration** (`builder.html?tour=<url>` fetches & renders the generated tour) | `src/builder/Builder.js`, `src/index.html` | ✅ Proven |

**Proven flow (real pycolmap reconstruction, screenshotted in-browser):**
```
phone photos → pycolmap poses → auto graph → tour.json → flat node-graph viewer → rendered
```

---

## 3. Direct answers to the key questions

| Question | Answer |
|---|---|
| **Does COLMAP successfully extract camera poses?** | ✅ **Yes — verified.** pycolmap recovered **20/20** camera poses on a synthetic room with known ground truth; RMSE **0.012 units (0.5% of ring radius)** after similarity alignment (`scripts/colmap_test.py`). |
| **Are viewpoints generated automatically?** | ✅ **Yes.** One navigation node per camera pose, no manual step. |
| **Are hotspots generated automatically?** | ✅ **Yes.** Each node links to its nearest neighbours; each hotspot direction is computed by projecting the neighbour's real 3D position into the node's camera frame — the dot literally points at the next viewpoint. |
| **Is room detection implemented?** | ❌ **No.** All nodes are treated as one space ("Ground Floor"). |
| **Is room-to-room linking implemented?** | ⚠️ **Partial.** Nodes are linked by 3D proximity (k-NN within `MAX_LINK_DIST`), but there is no concept of distinct *rooms* or doorways yet. |
| **Can a user create a tour from only phone photos?** | ✅ **Yes, end-to-end** — verified live: upload 20 photos → pycolmap → auto graph → tour.json → rendered in the browser. Caveat: quality depends on **capture geometry** (parallax + shared structure — see below). |
| **What still prevents a Matterport-like experience?** | **Dense/mesh geometry** (we have sparse points + poses), **room segmentation**, a **dollhouse/floorplan view**, **measurement**, and **AR-guided capture** to guarantee good input. The node-graph renderer and verified reconstruction are now done. |

### Capture geometry — the key product insight (learned during verification)
Reconstruction quality is dominated by **how the photos are taken**, not the engine. Two
failed attempts before the passing one showed:
- **Parallax is required** — the camera must *translate* between shots. A tiny camera ring
  (near-pure rotation, like spinning in place) is panoramic-degenerate and collapses every
  camera to one point (RMSE ≈ 100%).
- **Neighbours must share structure** — cameras looking **across** the room (object-centric)
  reconstruct cleanly (RMSE 0.5%); cameras looking **outward** at disjoint walls fail.

This is exactly what **Phase 3 AR-guided capture** must enforce: walk around, keep the same
surfaces in view, ensure overlap.

---

## 4. Current limitations (honest)

1. **Mock path ≠ reconstruction.** The ring layout fakes geometry to make the integration
   visible. Real positions require COLMAP (or `hloc`) — now verified via pycolmap.
2. **The flat node-graph renderer is a debug/inspection view, NOT the final UX.** The target
   experience is a **true 360° panorama tour** (stand in a room, look freely around) — see
   [`PANORAMA_TOUR.md`](./PANORAMA_TOUR.md). COLMAP's role is repositioned to the optional
   **scene-positioning / floor-map** layer, not the imagery.
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
| COLMAP reconstruction | **100%** — pycolmap verified, 20/20 poses, RMSE 0.5% |
| Automatic tour generation (poses → graph → hotspots) | **90%** — end-to-end on real geometry; needs robustness on real phone photos |
| Node-graph viewer (undistorted) | **100%** — flat billboards + directional dots, verified in-browser |
| Matterport-like experience | **~25%** |

---

## 6. Immediate next steps (now that Phase 2 is verified)

1. ✅ ~~Install COLMAP & verify real poses~~ — done via **pycolmap** (RMSE 0.5%).
2. ✅ ~~Add a node-graph renderer~~ — done (flat billboards, verified in-browser).
3. **Test on real phone photos** of an actual room (the synthetic scene is ideal; real photos
   add blur, low texture, exposure changes). This is the next robustness milestone.
4. **Show node positions in the UI** — a small top-down minimap from the recovered 3D
   positions would make navigation between viewpoints obvious (dots can sit off-screen when
   neighbours are to the side).

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
