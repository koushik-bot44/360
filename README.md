# 360 Virtual Tour

Create and share immersive **360° virtual tours** from your phone — capture rooms,
connect them with hotspots, and look in any direction right in the browser. The goal
is a true *stand-inside-the-room-and-look-around* experience (Zillow 3D Home / Kuula
class), not a slideshow of flat photos.

Built with **Three.js**: each scene is an equirectangular panorama rendered on a
sphere, with drag-to-look, click-to-move hotspots, multiple floors, and shareable tours.

## What's here

| Part | Path | Status |
|---|---|---|
| **Tour builder** (the product) — upload/capture 360° rooms, hotspots, floors, preview, share | `src/builder/` | ✅ Working |
| **Static landing** → links to the builder | `src/index.html` | ✅ Working |
| **Reconstruction backend** (Phase 2) — photos → camera poses → auto tour graph | `backend/` | ✅ pycolmap verified (optional) |

## Documentation
- [`PANORAMA_TOUR.md`](./PANORAMA_TOUR.md) — **the forward plan**: phone-guided capture →
  automatic panorama stitching → sphere scenes → auto-linked 360° tour. Read this first.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design for the AI/COLMAP next-generation system.
- [`STATUS.md`](./STATUS.md) — honest, verified status + Phase 3–5 roadmap.

## Getting started
```bash
npm install
npm run start     # dev server → http://localhost:3000/  (builder front-end)
npm run build     # production build → ./dist
```
The front-end is fully static — no backend required to build manually-captured 360° tours.
The optional Python backend (photo → reconstruction) lives in [`backend/`](./backend) and
runs separately; see its README.

## How a tour works
- Each **scene** = one equirectangular 360° image (from a 360 camera, a phone Photo
  Sphere, or — future — auto-stitched phone photos).
- **Hotspots** are white dots you place (or auto-generate) that link scenes together.
- Tours are stored in **IndexedDB** and can be exported/imported as a self-contained
  `.tour.json` (images embedded), or shared by link.

## Project structure
```
src/
  index.html        static landing page
  builder.html/js   tour-builder entry
  builder/          PanoViewer (sphere), Capture, TourStore (IndexedDB), cubeToEquirect
backend/            optional: FastAPI + pycolmap reconstruction POC
static/             icons, demo tour + panoramas, manifest
webpack/            build configuration
```

## License
MIT — see [LICENSE](LICENSE). The 360° sphere viewer builds on ideas from the
open-source SPHR engine ([lukehollis/sphr](https://github.com/lukehollis/sphr)).
