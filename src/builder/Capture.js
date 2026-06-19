/**
 * Capture.js — AR-guided 360° panorama capture.
 *
 * Opens the device camera and overlays a ring of reticle dots at the yaw angles
 * still to be shot (12 targets, 30° apart = one horizontal ring ≈ 40%+ overlap).
 * On a phone the dots track your orientation (DeviceOrientationEvent) and the
 * crosshair "locks" when you're aimed at a target; on desktop you drag to look.
 * Quality gates before/within capture:
 *   • blur rejection (variance of Laplacian)
 *   • walk detection (accelerometer) — warns if you translate instead of rotating
 * When enough of the ring is captured it hands an ordered list of JPEG blobs
 * (named by yaw, e.g. yaw_030.jpg) to onComplete for stitching → POST /panorama.
 */

// 12 evenly-spaced yaw targets — one full horizontal ring.
const TARGETS = Array.from({ length: 12 }, (_, i) => ({
  key: `y${i * 30}`, label: `${i * 30}°`, az: i * 30, el: 0,
}));

const MIN_SHOTS = 8;       // allow finishing once most of the ring is covered
const FOV = 65;            // assumed phone h-fov for projecting dots
const LOCK_ANGLE = 11;     // deg crosshair must be within target to lock
const BLUR_MIN = 55;       // laplacian-variance threshold
const WALK_ACCEL = 2.2;    // m/s² (gravity-excluded) sustained ⇒ "you're walking"

const $ = (id) => document.getElementById(id);
function angDiff(a, b) { let d = ((a - b + 540) % 360) - 180; return d; }

export default class Capture {
  constructor(onComplete) {
    this.onComplete = onComplete;
    this.captured = {};        // key -> { canvas, yaw, pitch, t }
    this.az = 0; this.el = 0;
    this.hasOrientation = false;
    this.stream = null;
    this.raf = null;
    this._accelEMA = 0;        // smoothed linear-acceleration magnitude
    this._walking = false;
    this._mkDom();
  }

  // ---------- lifecycle ----------
  async open(roomName) {
    this.captured = {};
    this.roomName = roomName || 'Room';
    this._t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    $('cap-room-name').textContent = this.roomName;
    this.root.classList.remove('hidden');
    document.body.classList.add('capturing');

    this._buildDots();
    this._renderTargets();
    if (!this.raf) this._loop();
    this._initMotion();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (e) {
      this._toast('Camera blocked. Allow camera permission (and use HTTPS on a phone), then reopen.', true);
    }
  }

  close() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('devicemotion', this._onMotion);
    this.root.classList.add('hidden');
    document.body.classList.remove('capturing');
  }

  // ---------- orientation + motion ----------
  async _initMotion() {
    this._onOrient = (e) => {
      if (e.alpha == null) return;
      this.hasOrientation = true;
      this.az = (360 - e.alpha) % 360;                      // yaw
      this.el = Math.max(-90, Math.min(90, (e.beta || 90) - 90));  // pitch
    };
    // accelerometer → detect physical translation (walking) vs pure rotation
    this._onMotion = (e) => {
      const a = e.acceleration || {};                       // gravity excluded
      if (a.x == null) return;
      const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      this._accelEMA = this._accelEMA * 0.8 + mag * 0.2;
      this._walking = this._accelEMA > WALK_ACCEL;
    };
    try {
      const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        if (await DOE.requestPermission() === 'granted') window.addEventListener('deviceorientation', this._onOrient);
      } else if (DOE) { window.addEventListener('deviceorientation', this._onOrient); }
      if (DME && typeof DME.requestPermission === 'function') {
        if (await DME.requestPermission() === 'granted') window.addEventListener('devicemotion', this._onMotion);
      } else if (DME) { window.addEventListener('devicemotion', this._onMotion); }
    } catch (e) { /* manual mode */ }
    setTimeout(() => { this.manual = !this.hasOrientation; this.root.classList.toggle('manual-mode', this.manual); }, 700);
  }

  // ---------- render loop ----------
  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    const remaining = TARGETS.filter(t => !this.captured[t.key]);
    const done = TARGETS.length - remaining.length;
    $('cap-progress').textContent = `${done}/${TARGETS.length}`;
    this.needle.style.transform = `rotate(${this.az}deg)`;

    let nearest = null, nearestDist = Infinity;
    remaining.forEach(t => {
      const dist = Math.hypot(angDiff(t.az, this.az), t.el - this.el);
      if (dist < nearestDist) { nearestDist = dist; nearest = t; }
    });

    TARGETS.forEach(t => {
      const dot = this.dots[t.key];
      if (!dot) return;
      const daz = angDiff(t.az, this.az);
      const x = 50 + (daz / FOV) * 50;
      const y = 50 - ((t.el - this.el) / FOV) * 50;
      dot.style.display = (x > -6 && x < 106 && y > -6 && y < 106) ? 'flex' : 'none';
      dot.style.left = x + '%'; dot.style.top = y + '%';
      dot.classList.remove('current', 'done', 'pending');
      dot.classList.add(this.captured[t.key] ? 'done' : (t === nearest ? 'current' : 'pending'));
    });

    const locked = nearest && nearestDist < LOCK_ANGLE && !this._walking;
    this.crosshair.classList.toggle('locked', !!locked);
    this.crosshair.classList.toggle('warn', !!this._walking);
    this._target = nearest;

    const how = this.hasOrientation ? 'Turn' : 'Drag';
    let msg;
    if (this._walking) msg = '⚠ Stay in one spot — rotate in place, don\'t walk';
    else if (!nearest) msg = 'Ring complete — press Finish to stitch';
    else if (locked) msg = `Aligned (${nearest.label}) — tap the shutter ✓`;
    else msg = `${how} to bring the ${nearest.label} dot into the crosshair`;
    $('cap-guidance').textContent = msg;

    $('cap-shoot').disabled = !locked;
    $('cap-finish').disabled = done < MIN_SHOTS;
    $('cap-finish').textContent = done < MIN_SHOTS ? `Finish (need ${MIN_SHOTS - done})` : `Finish & stitch (${done})`;
  }

  // ---------- capture ----------
  _grabFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return null;
    const scale = Math.min(1, 1280 / Math.max(vw, vh));     // keep full FOV, cap size
    const c = document.createElement('canvas');
    c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
    c.getContext('2d').drawImage(this.video, 0, 0, c.width, c.height);
    return c;
  }

  shoot(forKey) {
    const target = forKey ? TARGETS.find(t => t.key === forKey) : this._target;
    if (!target) return;
    if (this._walking) { this._toast('You moved — stand still and rotate in place, then capture.', true); return; }
    const frame = this._grabFrame();
    if (!frame) return;
    const sharp = this._sharpness(frame);
    if (sharp < BLUR_MIN) {
      this._toast(`Looks blurry (score ${Math.round(sharp)}). Hold still and retake.`, true);
      return;
    }
    this.captured[target.key] = {
      canvas: frame, yaw: Math.round(this.az), pitch: Math.round(this.el),
      t: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - this._t0),
    };
    this._toast(`✓ ${target.label} captured (sharpness ${Math.round(sharp)})`);
    this._renderTargets();
    if (Object.keys(this.captured).length === TARGETS.length) this._finish();
  }

  // variance of Laplacian — higher = sharper
  _sharpness(canvas) {
    const n = 200;
    const t = document.createElement('canvas'); t.width = t.height = n;
    const c = t.getContext('2d'); c.drawImage(canvas, 0, 0, n, n);
    const d = c.getImageData(0, 0, n, n).data;
    const g = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) g[i] = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2];
    let mean = 0; const lap = new Float32Array(n * n);
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      lap[i] = -4 * g[i] + g[i-1] + g[i+1] + g[i-n] + g[i+n];
      mean += lap[i];
    }
    mean /= (n * n);
    let varr = 0;
    for (let i = 0; i < n * n; i++) { const dv = lap[i] - mean; varr += dv * dv; }
    return varr / (n * n);
  }

  _finish() {
    const shots = TARGETS.filter(t => this.captured[t.key]).map(t => this.captured[t.key]);
    if (shots.length < MIN_SHOTS) {
      this._toast(`Capture at least ${MIN_SHOTS} shots around you first.`, true);
      return;
    }
    const roomName = this.roomName;
    // metadata sidecar (yaw/pitch/timestamp per shot) — kept for ordering / future use
    const meta = shots.map(s => ({ yaw: s.yaw, pitch: s.pitch, t: s.t }));
    this.close();
    Promise.all(shots.map(s => new Promise(res =>
      s.canvas.toBlob(b => res(b ? { blob: b, yaw: s.yaw } : null), 'image/jpeg', 0.9))))
      .then(items => {
        const frames = items.filter(Boolean).map(it =>
          new File([it.blob], `yaw_${String(it.yaw).padStart(3, '0')}.jpg`, { type: 'image/jpeg' }));
        this.onComplete && this.onComplete({ panoMode: true, frames, meta, roomName });
      });
  }

  // ---------- dom ----------
  _renderTargets() {
    const wrap = $('cap-manual-grid');
    wrap.innerHTML = '';
    TARGETS.forEach(t => {
      const b = document.createElement('button');
      b.className = 'cap-mbtn' + (this.captured[t.key] ? ' done' : '');
      b.textContent = (this.captured[t.key] ? '✓ ' : '') + t.label;
      b.addEventListener('click', () => this.shoot(t.key));
      wrap.appendChild(b);
    });
  }

  _buildDots() {
    this.dotsLayer.innerHTML = '';
    this.dots = {};
    TARGETS.forEach(t => {
      const d = document.createElement('div');
      d.className = 'cap-dot pending';
      d.innerHTML = `<span>${t.label}</span>`;
      d.addEventListener('click', () => this.shoot(t.key));
      this.dotsLayer.appendChild(d);
      this.dots[t.key] = d;
    });
  }

  _mkDom() {
    this.root = $('capture-overlay');
    this.video = $('cap-video');
    this.crosshair = $('cap-crosshair');
    this.needle = $('cap-needle');
    this.dotsLayer = $('cap-dots');
    this.dots = {};
    $('cap-shoot').addEventListener('click', () => this.shoot());
    $('cap-close').addEventListener('click', () => this.close());
    $('cap-finish').addEventListener('click', () => this._finish());

    // drag-to-look (used when there are no motion sensors, e.g. desktop)
    this._drag = null;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.cap-dot, button')) return;
      this._drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', (e) => {
      if (!this._drag || this.hasOrientation) return;
      this.az = (this.az + (e.clientX - this._drag.x) * 0.25 + 360) % 360;
      this.el = Math.max(-90, Math.min(90, this.el - (e.clientY - this._drag.y) * 0.25));
      this._drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => { this._drag = null; });
  }

  _toast(msg, warn) {
    const el = $('cap-toast');
    el.textContent = msg;
    el.classList.toggle('warn', !!warn);
    el.classList.remove('hidden');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => el.classList.add('hidden'), 2600);
  }
}
