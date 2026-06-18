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

# 2. Start the dev server
npm run start

# 3. Build for production
npm run build
```

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
MIT — see [LICENSE](LICENSE).

## Credits
This project builds on the open-source **SPHR** engine by Luke Hollis ([lukehollis/sphr](https://github.com/lukehollis/sphr)), extended and rebranded as **360 Virtual Tour**.
