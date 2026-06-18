# ARCHITECTURE.md — From 360° Tour Builder to AI-Assisted Virtual Tour Generator

> **Status:** design document. The current shipped product is the front-end MVP
> (upload panoramas → place hotspots → preview/share). This document specifies
> the *next-generation* system: guided phone capture of **ordinary photos** that
> are reconstructed into a navigable tour **automatically**, with no manual
> panorama stitching or hotspot creation.
>
> **Honesty note up front:** the in-browser-only constraint that the current MVP
> respects **cannot** carry into this system. Automatic reconstruction
> (Structure-from-Motion, dense reconstruction, Gaussian splatting) runs on a
> **server**, and the high-quality variants need a **GPU**. The browser only
> captures and uploads. Every claim below is annotated with *where it runs* and
> *roughly what it costs*.

---

## 0. The vision (target UX)

```
User opens website on phone
  → "Scan Room"
  → guided capture points appear (AR-anchored where possible, gyro-anchored otherwise)
  → user takes 10–20 ordinary photos from prompted directions/positions
  → photos + per-photo orientation/pose hints upload to a backend
  → backend estimates camera positions (Structure-from-Motion)
  → system auto-generates viewpoints + a room graph + transitions
  → a navigable virtual tour is created with NO manual hotspot work
  → user receives a shareable link
```

The "magic" users feel is **capture guidance + automatic camera-pose estimation +
automatic linking + smooth navigation** — not a single AI model.

---

## 1. End-to-end data flow

```
┌─────────────┐   capture     ┌──────────────────┐   upload (HTTPS)   ┌───────────────┐
│  Phone (web)│ ───────────▶  │ Capture buffer    │ ─────────────────▶ │  API (FastAPI)│
│  camera+IMU │   N photos +  │ (IndexedDB, local)│   multipart + JSON │               │
└─────────────┘   pose hints  └──────────────────┘                    └───────┬───────┘
                                                                               │ enqueue job
                                                                               ▼
                                                                       ┌───────────────┐
                                                                       │  Job queue     │
                                                                       │  (Redis/RQ)    │
                                                                       └───────┬───────┘
                                                                               ▼
                              ┌────────────────────────────────────────────────────────┐
                              │            CV WORKER (CPU, optional GPU)                  │
                              │  COLMAP SfM → camera poses + sparse cloud                 │
                              │  (optional) dense / mesh / Gaussian splat                 │
                              │  node generation + graph + transitions                    │
                              └───────────────┬────────────────────────────────────────┘
                                              ▼ writes
                  ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
                  │ Object store │     │  Postgres     │     │  Generated assets │
                  │ (S3) images  │     │ tour metadata │     │ poses/graph/splat │
                  └──────────────┘     └──────────────┘     └──────────────────┘
                                              ▲
                                              │ GET tour.json + assets
                                       ┌──────┴───────┐
                                       │ Viewer (web) │  Three.js: node graph or splat
                                       └──────────────┘
```

**State machine of a capture job:** `uploading → queued → reconstructing → generating → ready | failed`. The phone polls (or subscribes via WebSocket) for status and shows progress.

---

## 2. Frontend architecture

Two front-ends share a component library:

- **Capture app (phone):** `getUserMedia` camera + `DeviceOrientation`/`DeviceMotion` for pose hints; optional **WebXR** (`immersive-ar`, Android Chrome only) for true world-anchored markers + hit-testing. Captures frames to canvas, stores `{blob, pose, ts}` locally (IndexedDB) so a flaky connection doesn't lose a scan, then uploads.
- **Viewer/editor app (desktop+phone):** Three.js. Renders either (a) the auto-generated **node graph** (panorama/photo viewpoints + transitions) or (b) a **Gaussian-splat** scene, depending on the reconstruction tier.

```
frontend/
  capture/      camera, sensor capture, guidance markers, upload queue
  viewer/       three.js node-graph + splat renderers, hotspot nav
  shared/       api client, auth, tour schema types, UI kit
```

Stack: **React (or keep vanilla)** + **Three.js** + **Vite/Webpack**. WebXR is a *progressive enhancement*: present → AR-anchored markers; absent (all iOS, desktop) → gyro/drag-anchored markers (what the current build already does).

---

## 3. Backend architecture

- **API gateway** — FastAPI (Python). Auth, presigned upload URLs, job creation, status, tour CRUD, share links.
- **Job queue** — Redis + RQ/Celery. Reconstruction is minutes-long; never do it in the request.
- **CV workers** — containerized COLMAP/OpenMVG (+ optional OpenMVS/gsplat). CPU pool for SfM; optional GPU pool for dense/splat. Autoscale to zero when idle (cost control).
- **Object storage** — S3/R2 for raw photos + generated assets.
- **DB** — Postgres for users, tours, scenes, nodes, edges, job status.

```
backend/
  api/        FastAPI routes, auth, presign, job mgmt
  worker/     colmap_runner.py, graph_builder.py, splat_runner.py
  models/     SQLAlchemy schemas
  infra/      Dockerfiles, queue, S3 client
```

Why Python: COLMAP, OpenMVG/OpenMVS, pycolmap, OpenCV, gsplat/nerfstudio all live in the Python/C++ ecosystem.

---

## 4. Computer-vision pipeline

```
photos ─▶ feature detection (SIFT/SuperPoint)
       ─▶ feature matching (exhaustive / vocab-tree / sequential)
       ─▶ geometric verification (RANSAC, essential/fundamental matrix)
       ─▶ incremental/global SfM  ──▶ camera intrinsics + extrinsics (POSES) + sparse point cloud
       ─▶ [optional] MVS dense cloud ─▶ mesh (Poisson) ─▶ texture
       ─▶ [optional] Gaussian splatting (from poses) ─▶ photoreal 3D scene
       ─▶ node generation + room graph (always)
```

The **minimum useful output is camera poses** (extrinsics). Everything after MVS is optional polish. Capturing per-photo gyro orientation as a **pose prior** makes matching faster and more robust (seeds COLMAP, disambiguates symmetric rooms).

---

## 5. Camera-pose estimation approach

1. **Primary:** COLMAP SfM recovers full 6-DoF poses from image features. Robust, standard, open source.
2. **Priors from sensors:** attach `DeviceOrientation` (yaw/pitch/roll) per photo to constrain rotation and speed up matching.
3. **Fallback (no overlap / SfM fails):** if photos don't share enough features (e.g., one shot per wall), fall back to **orientation-only placement** — arrange viewpoints purely by gyro yaw/pitch on a ring. Less accurate (rotation only, no translation) but never fails. This is the current MVP's model and the safety net.

Capture guidance should enforce **~30–50% overlap** between consecutive photos — that overlap is exactly what SfM needs.

---

## 6. COLMAP integration

Run headless in a worker container:

```bash
colmap feature_extractor   --database_path db.db --image_path imgs/
colmap exhaustive_matcher  --database_path db.db          # or sequential_matcher for ordered capture
colmap mapper              --database_path db.db --image_path imgs/ --output_path sparse/
# poses + intrinsics → sparse/0/{cameras,images,points3D}.bin
```

Parse with **`pycolmap`** to get per-image world transforms → feed the graph builder. Wrap in Docker (`colmap/colmap` image). Typical small indoor set (15–25 imgs): **~1–4 min CPU**; faster with `sequential_matcher` when capture order is known.

---

## 7. Alternatives to COLMAP

| Tool | Role | Notes |
|---|---|---|
| **OpenMVG** | SfM | Lighter, scriptable; pairs with OpenMVS |
| **OpenMVS** | dense + mesh | Use after OpenMVG/COLMAP poses |
| **pycolmap** | SfM in-process | No shelling out; cleaner worker |
| **OpenCV `sfm`/manual** | SfM | DIY; educational but fiddly |
| **hloc (SuperPoint+SuperGlue)** | matching | Best for low-texture indoor rooms where SIFT struggles |
| **Meshroom (AliceVision)** | full pipeline | GUI/CLI; heavier |
| **Nerfstudio / gsplat / Instant-NGP** | novel-view synth | GPU; replaces mesh with NeRF/splat |
| **RealityCapture/Metashape** | commercial | Fast, licensed, not OSS |

**Indoor reality:** rooms have blank walls → classic SIFT matching can be weak. **hloc (SuperPoint+SuperGlue)** materially improves indoor robustness and is worth adopting early.

---

## 8. Automatic room-detection logic

Goal: split a multi-room capture into separate rooms automatically.

- **Capture-driven (MVP):** user taps "New Room" between rooms → rooms are explicit. Zero CV. **Recommended first.**
- **Pose-cluster (v2):** cluster camera positions spatially (DBSCAN on XY); doorway traversals show as low-density bridges between clusters → each cluster = a room.
- **Semantic (advanced):** run room-layout / wall-segmentation (e.g., a layout-estimation model, or plane segmentation on the dense cloud) to detect walls/doorways and partition the floor plan.

---

## 9. Automatic hotspot-generation logic

Replace manual dot-placement with derived transitions:

1. **Within a room:** every camera pose becomes a navigation node. Connect nodes whose viewpoints overlap (shared 3D points or distance < threshold) → walkable graph.
2. **Between rooms:** detect doorway transitions where a node in room A sees into room B (shared points across clusters, or nearest-node bridge) → cross-room hotspot.
3. **Placement:** a hotspot's on-screen position is the **projection of the target node's 3D position** into the current view — so the dot literally sits where the next viewpoint is. No manual aiming.
4. **Pruning:** keep the minimum spanning graph + a few shortcuts so the UI isn't littered with dots.

This is the single biggest UX win over the current manual builder.

---

## 10. Data schemas

```jsonc
// Tour
{ "id": "uuid", "owner": "uuid", "title": "string",
  "details": { "description": "string", "amenities": ["string"] },
  "floors": ["Ground Floor"],
  "status": "ready|reconstructing|failed",
  "rooms": ["roomId"], "createdAt": "iso" }

// Room
{ "id": "uuid", "tourId": "uuid", "name": "string", "floor": "string",
  "nodes": ["nodeId"], "reconstruction": { "engine": "colmap|orientation|splat", "quality": 0-100 } }

// Node (a viewpoint = a camera pose)
{ "id": "uuid", "roomId": "uuid",
  "image": "s3://.../photo.jpg",                 // or panorama
  "pose": { "position": [x,y,z], "rotation": [qx,qy,qz,qw] },
  "intrinsics": { "fx":0,"fy":0,"cx":0,"cy":0 },
  "captureHint": { "alpha":0,"beta":0,"gamma":0, "ts": 0 } }

// Edge (auto-generated transition / hotspot)
{ "id": "uuid", "from": "nodeId", "to": "nodeId", "type": "intra|doorway", "label": "string?" }

// CaptureSession (phone → backend)
{ "id":"uuid","roomName":"string",
  "shots":[ {"blobRef":"local|s3","pose":{"alpha":0,"beta":0,"gamma":0},"ts":0} ] }
```

The **node/edge graph** is the heart — it makes "tour" = "graph of viewpoints," and is backward-compatible with the current scene/hotspot model (a scene = a node, a hotspot = an edge).

---

## 11. API endpoints

```
POST   /auth/login
POST   /tours                         → create tour
GET    /tours/:id                     → tour + rooms + nodes + edges
POST   /tours/:id/rooms               → start a room/capture session
POST   /uploads/presign               → presigned S3 PUT urls (batch)
POST   /rooms/:id/captures            → register uploaded shots + pose hints, enqueue job
GET    /jobs/:id                       → { status, progress, error? }
WS     /jobs/:id/stream                → live progress
GET    /rooms/:id/reconstruction       → poses + graph (when ready)
POST   /tours/:id/publish              → create public share link
GET    /v/:slug                        → public viewer payload (tour.json + asset urls)
```

---

## 12. Storage design

| Data | Store | Why |
|---|---|---|
| Raw photos, generated meshes/splats | **S3 / R2** | large binaries, CDN delivery |
| Tour/room/node/edge metadata | **Postgres** | relational graph, queries |
| Job status | **Postgres/Redis** | fast polling |
| On-device capture buffer | **IndexedDB** | survive reload/offline before upload |
| Current MVP tours | **IndexedDB** (this repo, step #1) | full-res images exceed localStorage's ~5 MB |

---

## 13. Deployment architecture

```
Cloudflare/CDN ─ static front-ends (S3 + CDN)
      │
   API (FastAPI)  ── Fly.io / Render / ECS (autoscale)
      │
   Redis queue
      │
   CV workers ── CPU pool (SfM)         : spot/preemptible, scale-to-zero
              ── GPU pool (splat/NeRF)  : on-demand only, scale-to-zero  ← cost driver
      │
   Postgres (managed)   +   S3/R2 (objects)
```

Keep GPU **scale-to-zero**; spin up only for splat/NeRF jobs.

---

## 14. Cost estimates (order-of-magnitude)

| Item | Dev/hobby | Light production |
|---|---|---|
| API + DB + Redis | $0–25/mo (free tiers) | ~$50–120/mo |
| Object storage + egress | ~$5/mo | $20–100/mo (CDN egress) |
| CPU SfM worker | ~$0 if scale-to-zero | ~$0.02–0.08 / scan |
| **GPU splat/NeRF** | rented per-job | **~$0.50–2.00 / scan** (minutes of GPU) |
| **Total** | **~$10–40/mo + per-scan** | **$100–400/mo + per-scan** |

**Takeaway:** the MVP-with-SfM tier is cheap (CPU, scale-to-zero). The Matterport-like splat tier is where real money starts (GPU minutes per scan).

---

## 15. MVP version (realistic student build)

```
Guided capture (gyro-anchored markers, ordinary photos, ~30% overlap)
   ↓  upload photos + per-photo orientation
COLMAP SfM (CPU worker) → camera poses
   ↓
Auto-generate nodes (one per pose) + intra-room edges by proximity/overlap
   ↓
Three.js viewer: stand at a node, see neighbor dots projected from real 3D positions, click to move
```
- No mesh, no GPU, no panorama stitching.
- "New Room" button for room separation; cross-room edges by nearest-node bridge.
- **Feasible scope; ~3–6 focused weeks.** Resume-worthy ("automatic camera-pose estimation + auto-generated tour graph using COLMAP").

## 16. Advanced version

- **hloc** matching for robust indoor low-texture scenes.
- **Pose-cluster room detection** + doorway edge detection (drop the manual "New Room").
- **OpenMVS** dense mesh for a walkable 3D shell, or **Gaussian splatting** for photoreal free-viewpoint (GPU).
- WebXR AR-anchored capture markers on Android.
- **+4–10 weeks**, plus GPU infra.

## 17. Future Matterport-like version

- Use **LiDAR depth** where available (iPhone Pro / Android ToF) via a **native app** (ARKit/ARCore) — the browser can't read depth.
- Cloud **dense reconstruction + AI room segmentation + floor-plan generation**, photoreal **Gaussian splat / NeRF** digital twin, measurement tools, dollhouse view.
- This is a **funded, multi-engineer, multi-quarter** effort with ongoing GPU cost — not a student project. Listed for completeness/north-star.

---

## Workflow comparison

| Workflow | How it works | Advantages | Disadvantages | Difficulty | Est. time | Needs server? |
|---|---|---|---|---|---|---|
| **Panorama (current MVP)** | Upload/assemble equirectangular, manual hotspots | Simple, cheap, seam-free with a 360 cam; **works on every phone incl. iOS** | Manual hotspots; needs a 360 photo or stitching | ★☆☆☆☆ | **Done** | No |
| **Guided-photo + orientation** | Ordinary photos arranged by gyro yaw/pitch (no SfM) | No special camera; "feels guided"; all-browser; no backend | Rotation-only (no real positions); approximate; seams if assembled | ★★☆☆☆ | 1–2 wks | Optional |
| **Polycam-style (SfM)** | Photos → COLMAP poses → auto node graph | **Automatic** tour + auto hotspots; real CV; resume-strong | Needs Python/COLMAP **server**; indoor low-texture can fail; CPU minutes | ★★★★☆ | 3–6 wks | **Yes (CPU)** |
| **Matterport-style (depth + splat/NeRF)** | Photos+depth → dense/splat digital twin | Photoreal true 3D; measurements; "wow" | **GPU** cost; LiDAR ⇒ native app; hard CV; ongoing $$$ | ★★★★★ | months | **Yes (GPU)** |

---

## Recommended path

1. **Now:** migrate MVP storage **localStorage → IndexedDB** (this repo, step #1) so it holds many full-res rooms — free, local, immediately useful.
2. **Next milestone:** stand up the **Polycam-style MVP** (capture → COLMAP poses → auto graph). This is the inflection point where the product stops being a "panorama viewer" and becomes an **"AI-assisted virtual tour generator."** It requires a Python/COLMAP backend (CPU) — modest cost, big payoff.
3. **Later/optional:** advanced (hloc, splat, AR) and the native LiDAR future.

**Bottom line on feasibility:** the *capture + SfM-poses + auto-graph* tier (§15) is genuinely buildable by one student and is the honest target. Full Matterport-grade reconstruction is **not** a browser project and **not** a solo-student timeframe — it needs GPUs, native depth access, and a team.
