/**
 * cubeToEquirect.js — assemble 6 directional captures into one 360° panorama.
 *
 * Honest about its limits: this is an *approximate* assembly, not a true
 * computer-vision stitch. Each phone shot is treated as one ~90° cube face;
 * the six faces are sampled into an equirectangular image so the result plugs
 * straight into the normal scene pipeline (and shows the usual seams of a
 * no-CV assembly).
 *
 * faces: { front, back, left, right, up, down } — each an image src / canvas.
 */
import * as THREE from 'three';

function toTexture(src) {
  return new Promise((resolve) => {
    if (src instanceof HTMLCanvasElement) {
      const t = new THREE.CanvasTexture(src);
      t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true;
      resolve(t);
      return;
    }
    new THREE.TextureLoader().load(src, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; resolve(t);
    }, undefined, () => resolve(null));
  });
}

const VERT = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Sample a cube map per equirectangular pixel. front => -z.
const FRAG = `
  precision highp float;
  varying vec2 vUv;
  uniform samplerCube cube;
  #define PI 3.141592653589793
  void main() {
    float lon = vUv.x * 2.0 * PI - PI;     // -PI .. PI
    float lat = vUv.y * PI - PI * 0.5;      // -PI/2 .. PI/2
    vec3 dir = vec3(cos(lat) * sin(lon), sin(lat), -cos(lat) * cos(lon));
    gl_FragColor = textureCube(cube, normalize(dir));
  }
`;

/**
 * Returns a Promise<string> data URL of an equirectangular JPEG.
 */
export default async function cubeToEquirect(faces, width = 2048) {
  const height = width / 2;

  // Build a CubeTexture in THREE's face order: [px, nx, py, ny, pz, nz]
  //  px=right, nx=left, py=up, ny=down, pz=back, nz=front
  const order = [faces.right, faces.left, faces.up, faces.down, faces.back, faces.front];
  const texes = await Promise.all(order.map(toTexture));

  // Render each face texture into a square cube-render-target via 6 draws.
  const size = 1024;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Make a CubeTexture from canvases (draw each face image onto a square canvas).
  const faceCanvases = order.map((src, i) => drawSquare(texes[i], size));
  const cubeTex = new THREE.CubeTexture(faceCanvases);
  cubeTex.colorSpace = THREE.SRGBColorSpace;
  cubeTex.needsUpdate = true;

  // Fullscreen quad with the equirect shader.
  const scene = new THREE.Scene();
  const cam = new THREE.Camera();
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: { cube: { value: cubeTex } } })
  );
  scene.add(quad);

  renderer.render(scene, cam);

  const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.9);

  // cleanup
  quad.geometry.dispose();
  quad.material.dispose();
  cubeTex.dispose();
  texes.forEach(t => t && t.dispose());
  renderer.dispose();

  return dataUrl;
}

// Draw a texture's image onto an opaque square canvas (fallback gray if missing).
function drawSquare(tex, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, size, size);
  const img = tex && tex.image;
  if (img && (img.width || img instanceof HTMLCanvasElement)) {
    // center-crop to square
    const iw = img.width, ih = img.height;
    const s = Math.min(iw, ih);
    const sx = (iw - s) / 2, sy = (ih - s) / 2;
    try { ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size); } catch (e) { /* ignore */ }
  }
  return c;
}
