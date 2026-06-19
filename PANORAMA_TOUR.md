# Panorama Tour — design for a *true* 360° experience

_The goal: stand inside a room and look freely around — like Zillow 3D Home / Kuula —_
_not a slideshow of flat photos. This document is the pipeline for getting there._

The good news: **capture, stitch, and viewer are built and verified.** `Capture.js` runs the
AR-guided ring capture, `POST /panorama` (OpenCV Stitcher) produces the equirectangular, and
`PanoViewer.js` renders it on a sphere with drag-to-look — the full "stand and look around"
experience. The remaining piece is **automatic scene linking** (hotspots between rooms) and a
**full-sphere** capture to remove the floor/ceiling caps.

---

## 1. The core idea: a panorama is *rotation*, not structure

This is the single most important fact, and it's the **opposite** of the COLMAP/SfM work:

| | Panorama (per viewpoint) | SfM / COLMAP (between viewpoints) |
|---|---|---|
| Camera motion | **Rotates in place** (one fixed point) | **Translates** (walks around) |
| Images related by | a pure **rotation** → 2D homography | full 3D geometry + parallax |
| Parallax is | the **enemy** (causes ghosting) | **required** (no parallax → fails) |
| Output | one seamless equirectangular image | camera positions + sparse 3D points |

So **each scene = one panorama**, made by standing still and rotating the phone. You do *not*
need depth or 3D structure to make the panorama — just the inter-image rotations. This is why
phone panorama apps work handheld: they assume you pivot in place.

---

## 2. How a panorama is generated from ordinary phone photos

Standard stitching pipeline (this is what OpenCV's `Stitcher` and Hugin do internally):

```
overlapping phone photos
  1. detect + match features across overlaps        (ORB / SIFT / AKAZE)
  2. estimate pairwise rotations + focal length, then
     GLOBAL bundle-adjust all rotations together     (so error doesn't accumulate / drift)
  3. warp every image onto a sphere -> equirectangular canvas   (spherical projection)
  4. exposure compensation (gain) across images       (hide brightness steps)
  5. seam finding (graph cut) + multi-band blending    (hide remaining seams)
  -> one equirectangular JPEG  (e.g. 4096×2048)
     -> drop straight into PanoViewer as scene.image  (already works)
```

Steps 4–5 are what separate a "looks pro" pano from an obvious-seams one.

---

## 3. Libraries / tools (recommended)

| Tool | Role | Notes |
|---|---|---|
| **OpenCV `Stitcher` (PANORAMA mode, SPHERICAL warper)** | MVP stitcher | One call does the whole pipeline. Great for a horizontal band; weak at the poles (straight up/down). Python: `cv2.Stitcher_create(cv2.Stitcher_PANORAMA)`. |
| **`stitching` (PyPI)** | Tunable stitcher | Pure-Python wrapper exposing each stage of the OpenCV pipeline — better when the one-shot Stitcher fails. The right step up from raw OpenCV. |
| **Hugin / panotools CLI** (`cpfind`, `autooptimiser`, `nona`, `enblend`) | Gold-standard full-sphere | Best true 360×180 equirectangular incl. zenith/nadir, best blending. Heavier to install; scriptable. Use when OpenCV's poles aren't good enough. |
| **360 camera path** (Ricoh Theta, Insta360) | Skip stitching entirely | Produces a clean equirectangular straight away — the builder already accepts equirectangular uploads. Best quality-for-effort; worth offering as an option. |

**Recommendation:** start with OpenCV PANORAMA mode on the backend (you already added
pycolmap/opencv there). Move to `stitching` for tuning, and to Hugin only if you need clean
poles. Always keep the **360-camera upload** path open — it's the quality escape hatch.

---

## 4. Direct answers to your questions

**Is COLMAP still needed?**
- **For making each panorama: No.** Stitching is pure-rotation; SfM is the wrong tool (and it
  *needs* translation, which a panorama capture deliberately avoids).
- **For auto-linking / positioning scenes: Optional, and that's its new role.** To place a
  hotspot that points from room A toward room B — or to draw a floor-plan minimap — you need
  the *relative positions* of the viewpoints, which needs translation between them. Three
  options, cheapest first:
  1. **Capture order + pano-to-pano feature match** (MVP) — matching features between two
     adjacent panoramas gives the *bearing* from one to the other: enough to aim a hotspot,
     no metric map needed.
  2. **A few "transit" photos while walking** between viewpoints → light COLMAP run → metric
     positions for a real minimap. (This is exactly where the verified pycolmap work is reused.)
  3. **Skip it** — let the user drop links manually (the existing hotspot editor already does).

**Is OpenCV stitching enough?**
- **For "look around horizontally": yes.** A 360°×~120° spherical band already feels fully
  immersive in the sphere viewer — you can spin all the way around and tilt a bit up/down.
- **For a *full* sphere (clean zenith + nadir): not reliably.** OpenCV warps poorly at the
  poles. MVP ships the band and caps floor/ceiling with a single up/down shot or a neutral
  gradient; the full-sphere upgrade is Hugin.
- **Ghosting from handheld parallax** happens with any tool if you pivot around your body
  instead of the lens. Mitigation: capture guidance (below) + multi-band blending + seam masks.

---

## 5. Capture pattern the user must follow

This is enforced by AR/orientation guidance (reuse `Capture.js`, which already tracks yaw/pitch
and rejects blur):

- **Stand still and pivot in place.** Rotate so the phone's *lens* stays near one point (pivot
  the wrist, don't orbit with your whole body) — minimizes parallax/ghosting.
- **Hold the phone portrait** — more vertical field of view per shot.
- **Lock exposure & focus** (AE/AF lock) before starting — keeps brightness consistent for clean blending.
- **One horizontal ring:** a photo every **~30°** → **12 shots**, ~40–50% overlap, horizon kept level.
- **Fuller sphere (optional):** add a ring tilted **~45° up** and one **~45° down** (≈ 12 + 8 + 8),
  plus a straight-up and straight-down shot. ~30 photos total.
- The guide shows target reticles at the required angles, "locks" when aligned, auto-captures a
  sharp frame, and tracks coverage % so the user knows when a viewpoint is done.

Then **walk to the next spot and repeat.** Optionally shoot a few frames while walking (for the
COLMAP positioning option).

---

## 6. MVP implementation plan

Reuse-heavy — most pieces exist:

| Step | Work | Status |
|---|---|---|
| 1. **Guided capture** | AR reticle ring (12 @ 30°), crosshair lock, blur reject, walk detection, yaw/pitch/timestamp metadata, auto-stitch on finish (`Capture.js`) | ✅ **Done** |
| 2. **Stitch** | `POST /panorama` → OpenCV PANORAMA stitch → 2:1 equirectangular + debug (`stitch.py`) | ✅ **Done** |
| 3. **Scene** | Equirectangular becomes `scene.image` in the sphere viewer | ✅ **Done** (reused `PanoViewer` + `TourStore`) |
| 4. Auto-link | Create hotspots from capture order; bearing via pano-to-pano feature match | ⏳ Next |
| 5. Fallbacks | Manual hotspot editor; 360-camera equirectangular upload; 🧩 stitch-from-files | ✅ Done |

`cubeToEquirect.js` (the old approximate assembler) has been **removed** — the real stitch
replaces it. The flat node-graph / photo-billboard renderer was also dropped (not this UX).

Milestone order: (1) ✅ backend stitch endpoint; (2) ✅ guided capture; (3) auto-link rooms;
(4) full-sphere via Hugin (kill the floor/ceiling caps); (5) optional COLMAP minimap.

---

## 7. Expected visual quality vs. the benchmarks

| Product | How it's built | What you get | Can we match it? |
|---|---|---|---|
| **Kuula** | Hosts equirectangular 360s (from 360 cams or stitched) + hotspots | Clean look-around, hotspot navigation | **Yes** — same output class. We *add* auto-capture + stitch. |
| **Zillow 3D Home** | Phone-rotated panoramas (or 360 cam), auto-linked nodes | True look-around tour, jump/fade between rooms, no 3D mesh | **Yes — this is the realistic target.** Parity for handheld phone capture; better with a 360 camera. |
| **Matterport** | Depth/LiDAR → textured **3D mesh** | Dollhouse view, measurements, free-walk with depth-warped transitions | **No.** We have discrete pano nodes with jump transitions, no mesh/measurement. (Our optional COLMAP positions could add a simple floor-plan minimap — a partial step, not a mesh.) |

**Honest summary:** with clean stitching we land at **Zillow 3D Home / Kuula class** — a
genuine "stand in the room and look around, then jump to the next room" 360° tour. We do **not**
reach Matterport (that needs depth capture and a 3D mesh). The biggest quality lever is the
**capture + stitch + blending**, not the viewer — and a 360 camera instantly closes most of the
remaining gap to the panorama-based competitors.
