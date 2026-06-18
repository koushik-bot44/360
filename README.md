# 360 Virtual Tour

An interactive **360° virtual tour and digital twin builder** for the web. Build immersive, photorealistic walkthroughs of real-world spaces — homes, properties, museums, showrooms — right inside the browser.

Built with **Three.js**, it renders equirectangular 360° imagery with a true 3D cursor, smooth point-to-point transitions, orbit/first-person view modes, and a fully customizable scene graph.

## Features
- 🏠 Custom 3D space navigation with smooth point-to-point transitions
- 🎥 Multiple viewing modes (First Person & Orbit / Dollhouse)
- 🖱️ Real 3D cursor that tracks the room mesh under the 360° image
- 🧭 Customizable tour points, annotations, and info panels
- 📱 Mobile-responsive design
- 🌍 Multi-language support
- 🔊 Per-tour audio (ambient, navigation SFX, narration)

## Tech Stack
- [Three.js](https://threejs.org/) — WebGL 3D rendering
- Webpack 5 — bundling & dev server
- Tailwind CSS — UI styling
- GLSL — custom shaders for transitions & VFX

## Getting Started
```bash
# 1. Install dependencies
npm install

# 2. Start the dev server  →  http://localhost:3000/
npm run start

# 3. Build for production   →  outputs to ./dist
npm run build
```

The dev server opens the tour at **http://localhost:3000/** with the bundled
demo space. No backend required — everything runs as a static front-end.

## What I built / changed
This started from the open-source SPHR engine and was turned into a
self-contained, runnable app:
- **Standalone host page** (`src/index.html`) — the engine shipped without one
  (it expected a Django backend to inject the DOM + data). I authored the full
  page, scaffolding, and embedded a consistent demo space + tour.
- **Custom interface layer** (`src/components/ui/Interface.js`, `src/ui.css`) —
  branded welcome screen, help/controls panel, info card, themed HUD, and
  keyboard shortcuts.
- **Fixed the build** — implemented missing engine modules
  (`spaceCustom`, `Photograph`, `Birds`) and corrected broken shader/import
  paths so `npm run build` and `npm run start` work out of the box.
- **Build tooling** — wired `HtmlWebpackPlugin`, made `dotenv` optional,
  switched output to a standard `dist/` served from the root URL.
- **Rebranding** — name, manifest, theme, and docs.

Build for a specific language by setting the `LANG` env variable:
```bash
LANG=en npm run build   # English
LANG=ar npm run build   # Arabic
```

## Building Tours
Tours and spaces are defined as JSON. See [`data/example_space.json`](data/example_space.json) and [`data/example_tour.json`](data/example_tour.json) for the expected format.

**Space JSON** defines viewpoint nodes (360° image, position, rotation) and scene settings.
**Tour JSON** defines the ordered tourpoints, camera moves, audio, annotations, and 3D models shown along the way.

## Project Structure
```
src/
  components/      Three.js scene components (EnvCube, Cursor, Dollhouse, Hud, ...)
  components/tour/ Tour UI & navigation
  components/fx/   Visual effects (dust, birds, godrays, ...)
  shaders/         GLSL shaders
  lib/             Utilities & Gaussian-splat support
data/              Example space & tour definitions
static/            Icons, locales, compiled assets
webpack/           Build configuration
```

## Customization
- Add custom scene effects and transitions
- Implement your own tour navigation logic
- Build custom UI components and info panels
- Extend the annotation system
- Add new languages

## License
MIT — see [LICENSE](LICENSE). Builds on the open-source SPHR engine
([lukehollis/sphr](https://github.com/lukehollis/sphr)); the original copyright
is retained in the license as MIT requires.
