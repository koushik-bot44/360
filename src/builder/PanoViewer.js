/**
 * PanoViewer.js — lightweight equirectangular 360° viewer.
 *
 * Renders a single panorama on the inside of a sphere, supports drag-to-look,
 * placing hotspots (build mode) and clicking hotspots (play mode). Unlike the
 * SPHR engine this takes any equirectangular image (incl. user uploads / data
 * URLs), so it powers the tour builder.
 */
import * as THREE from 'three';

const SPHERE_R = 500;
const HOTSPOT_R = 470;

export default class PanoViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1100);
    this.camera.position.set(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // inverted sphere = panorama shell
    const geo = new THREE.SphereGeometry(SPHERE_R, 60, 40);
    geo.scale(-1, 1, 1); // flip so texture faces inward
    this.sphereMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    this.sphere = new THREE.Mesh(geo, this.sphereMat);
    this.scene.add(this.sphere);

    this.hotspotGroup = new THREE.Group();
    this.scene.add(this.hotspotGroup);
    this.markers = []; // { mesh, data }

    // look state
    this.lon = 0; this.lat = 0;
    this._isDown = false; this._moved = false;
    this._px = 0; this._py = 0; this._downX = 0; this._downY = 0;

    this.mode = 'view'; // 'view' | 'place' | 'play'
    this.onPlace = null;  // (dirVec3) => void
    this.onHotspot = null; // (data) => void

    this._raycaster = new THREE.Raycaster();
    this._dotTexture = this._makeDotTexture();

    this._bind();
    this.resize();
    this._loop = this._loop.bind(this);
    this.renderer.setAnimationLoop(this._loop);
  }

  _makeDotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    // soft outer ring
    x.beginPath(); x.arc(64, 64, 46, 0, Math.PI * 2);
    x.fillStyle = 'rgba(255,255,255,0.28)'; x.fill();
    // solid white core
    x.beginPath(); x.arc(64, 64, 26, 0, Math.PI * 2);
    x.fillStyle = '#ffffff'; x.fill();
    x.lineWidth = 4; x.strokeStyle = 'rgba(0,0,0,0.25)'; x.stroke();
    const t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }

  _bind() {
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      this._isDown = true; this._moved = false;
      this._px = e.clientX; this._py = e.clientY;
      this._downX = e.clientX; this._downY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this._isDown) return;
      const dx = e.clientX - this._px;
      const dy = e.clientY - this._py;
      if (Math.abs(e.clientX - this._downX) + Math.abs(e.clientY - this._downY) > 4) this._moved = true;
      this.lon -= dx * 0.13;
      this.lat = Math.max(-85, Math.min(85, this.lat + dy * 0.13));
      this._px = e.clientX; this._py = e.clientY;
    });
    window.addEventListener('pointerup', (e) => {
      if (this._isDown && !this._moved) this._handleClick(e);
      this._isDown = false;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.fov = Math.max(35, Math.min(95, this.camera.fov + e.deltaY * 0.04));
      this.camera.updateProjectionMatrix();
    }, { passive: false });
  }

  _pointerNDC(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  _handleClick(e) {
    const ndc = this._pointerNDC(e);
    this._raycaster.setFromCamera(ndc, this.camera);

    if (this.mode === 'play' || this.mode === 'place') {
      // hotspots first
      const hits = this._raycaster.intersectObjects(this.markers.map(m => m.mesh), false);
      if (hits.length) {
        const marker = this.markers.find(m => m.mesh === hits[0].object);
        if (marker && this.onHotspot) this.onHotspot(marker.data);
        return;
      }
    }
    if (this.mode === 'place') {
      const hit = this._raycaster.intersectObject(this.sphere, false)[0];
      if (hit && this.onPlace) {
        this.onPlace(hit.point.clone().normalize());
      }
    }
  }

  loadPanorama(url) {
    return new Promise((resolve) => {
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        this.sphereMat.map = tex;
        this.sphereMat.color.set(0xffffff);
        this.sphereMat.needsUpdate = true;
        resolve();
      }, undefined, () => resolve());
    });
  }

  clearHotspots() {
    this.markers.forEach(m => this.hotspotGroup.remove(m.mesh));
    this.markers = [];
  }

  addHotspot(data) {
    // data: { id, dir:{x,y,z}, target, label }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._dotTexture, transparent: true, depthTest: false,
    }));
    const d = new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z).normalize();
    sprite.position.copy(d.multiplyScalar(HOTSPOT_R));
    sprite.scale.set(34, 34, 1);
    this.hotspotGroup.add(sprite);
    this.markers.push({ mesh: sprite, data });
  }

  setHotspots(list) {
    this.clearHotspots();
    (list || []).forEach(h => this.addHotspot(h));
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    const phi = THREE.MathUtils.degToRad(90 - this.lat);
    const theta = THREE.MathUtils.degToRad(this.lon);
    const target = new THREE.Vector3(
      100 * Math.sin(phi) * Math.cos(theta),
      100 * Math.cos(phi),
      100 * Math.sin(phi) * Math.sin(theta)
    );
    this.camera.lookAt(target);
    // gentle pulse on hotspots so they read as interactive
    const s = 34 + Math.sin(performance.now() * 0.004) * 3;
    this.markers.forEach(m => m.mesh.scale.set(s, s, 1));
    this.renderer.render(this.scene, this.camera);
  }
}
