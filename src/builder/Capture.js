/**
 * Capture.js — AR-guided FULL-SPHERE panorama capture.
 *
 * Opens the device camera and overlays reticle dots at the yaw/pitch positions
 * still to be shot. The pattern is three rings + the two poles for full 360×180
 * coverage (no dark floor/ceiling): a middle ring (12 @ 0°), an upper ring
 * (8 @ +55°), a lower ring (8 @ −55°), and zenith/nadir — 30 targets.
 * To stay clean (like a guided street-view capture) only the NEXT target dot is
 * shown at a time; aim it into the crosshair and — once aligned and steady for a
 * moment — it AUTO-captures (no tapping). Orientation is low-pass smoothed so the
 * dot doesn't jitter. On a phone the dot tracks your motion (DeviceOrientationEvent);
 * on desktop you drag to look.
 * Quality gates: blur rejection (variance of Laplacian) and walk detection
 * (accelerometer warns if you translate instead of rotating). When enough is
 * captured it hands an ordered list of JPEG blobs (named by yaw/pitch) to
 * onComplete for stitching → POST /panorama → full-sphere equirectangular.
 */

// Compact full-sphere target set (~14): middle ring + sparse upper/lower rings.
// Fewer dots = a quicker, less cluttered capture; the wide vertical FOV of the
// tilted rings still reaches the poles so there's (almost) no floor/ceiling cap.
const TARGETS = [
  ...Array.from({ length: 8 }, (_, i) => ({ key: `m${i}`, label: `${i * 45}°`, az: i * 45, el: 0 })),
  ...Array.from({ length: 3 }, (_, i) => ({ key: `u${i}`, label: '↑', az: i * 120 + 30, el: 50 })),
  ...Array.from({ length: 3 }, (_, i) => ({ key: `d${i}`, label: '↓', az: i * 120 + 30, el: -50 })),
];

const MIN_SHOTS = 8;       // the middle ring alone already gives a usable panorama
const FOV = 65;            // assumed phone h-fov for projecting dots
const LOCK_ANGLE = 12;     // deg crosshair must be within target to lock
const BLUR_MIN = 55;       // laplacian-variance threshold
const WALK_ACCEL = 2.2;    // m/s² (gravity-excluded) sustained ⇒ "you're walking"
const STICKY_MARGIN = 18;  // deg another target must beat the current one by to take over
const AUTO_MS = 650;       // hold aligned this long → auto-capture (hands-free)

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
      const tAz = (360 - e.alpha) % 360;                         // target yaw
      const tEl = Math.max(-90, Math.min(90, (e.beta || 90) - 90)); // target pitch
      if (!this.hasOrientation) { this.az = tAz; this.el = tEl; } // snap on first reading
      else {
        // Adaptive low-pass (1€-filter style): a flat factor can't tell a real
        // turn from compass micro-jitter. _gain() returns ~0 for tiny wobble
        // (dot holds still) but rises for genuine motion (dot still tracks).
        let d = ((tAz - this.az + 540) % 360) - 180;
        this.az = (this.az + d * this._gain(Math.abs(d)) + 360) % 360;
        const de = tEl - this.el;
        this.el += de * this._gain(Math.abs(de));
      }
      this.hasOrientation = true;
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

  // deg-of-change-per-event → smoothing weight. A deadband kills sensor jitter
  // when you're holding still; the weight ramps up so fast turns still track.
  _gain(speed) {
    if (speed < 0.6) return 0;     // deadband: ignore micro-jitter entirely
    if (speed < 3)   return 0.12;
    if (speed < 10)  return 0.3;
    return 0.5;
  }

  // ---------- render loop ----------
  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const remaining = TARGETS.filter(t => !this.captured[t.key]);
    const done = TARGETS.length - remaining.length;
    $('cap-progress').textContent = `${done}/${TARGETS.length}`;
    this.needle.style.transform = `rotate(${this.az}deg)`;

    // The single next target — we show ONLY this one to keep the screen clean.
    // It's STICKY: keep the current target until it's captured, and switch to
    // another only when that other is clearly (STICKY_MARGIN°) closer. Without
    // this, two near-equidistant targets flip back and forth on every wobble of
    // the compass, so a different dot flashes each frame ("too many dots").
    let cur = (this._target && !this.captured[this._target.key]) ? this._target : null;
    let nearest = cur;
    let nearestDist = cur ? Math.hypot(angDiff(cur.az, this.az), cur.el - this.el) : Infinity;
    remaining.forEach(t => {
      if (t === cur) return;
      const dist = Math.hypot(angDiff(t.az, this.az), t.el - this.el);
      const margin = cur ? STICKY_MARGIN : 0;   // no hysteresis when nothing is selected yet
      if (dist < nearestDist - margin) { nearestDist = dist; nearest = t; }
    });
    this._target = nearest;

    const clamp = (v) => Math.max(6, Math.min(94, v));
    TARGETS.forEach(t => {
      const dot = this.dots[t.key];
      if (!dot) return;
      if (t !== nearest) { dot.style.display = 'none'; return; }   // one dot at a time
      const x = 50 + (angDiff(t.az, this.az) / FOV) * 50;
      const y = 50 - ((t.el - this.el) / FOV) * 50;
      const onscreen = x > 0 && x < 100 && y > 0 && y < 100;
      dot.style.display = 'flex';
      dot.style.left = clamp(x) + '%'; dot.style.top = clamp(y) + '%';
      dot.classList.remove('done', 'pending');
      dot.classList.toggle('current', true);
      dot.classList.toggle('edge', !onscreen);                     // riding the edge = "turn this way"
    });

    const locked = nearest && nearestDist < LOCK_ANGLE && !this._walking;
    this.crosshair.classList.toggle('locked', !!locked);
    this.crosshair.classList.toggle('warn', !!this._walking);

    // hands-free auto-capture: hold aligned & steady for AUTO_MS → snap
    if (locked) {
      if (!this._lockStart) this._lockStart = now;
      this.crosshair.classList.add('arming');
      if (now - this._lockStart > AUTO_MS && !this._autoBusy) {
        this._autoBusy = true;
        this.shoot();                 // captures _target (blur-checked inside)
        this._autoBusy = false;
        this._lockStart = 0;
      }
    } else {
      this._lockStart = 0;
      this.crosshair.classList.remove('arming');
    }

    const how = this.hasOrientation ? 'Turn' : 'Drag';
    let msg;
    if (this._walking) msg = '⚠ Stay in one spot — rotate in place, don\'t walk';
    else if (!nearest) msg = 'All captured — press Finish to stitch';
    else if (locked) msg = 'Hold steady — capturing…';
    else msg = `${how} to bring the dot into the crosshair`;
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
    const tag = (v) => (v < 0 ? 'm' : 'p') + String(Math.abs(v)).padStart(3, '0');
    Promise.all(shots.map(s => new Promise(res =>
      s.canvas.toBlob(b => res(b ? { blob: b, yaw: s.yaw, pitch: s.pitch } : null), 'image/jpeg', 0.9))))
      .then(items => {
        const frames = items.filter(Boolean).map(it =>
          new File([it.blob], `y${tag(it.yaw)}_p${tag(it.pitch)}.jpg`, { type: 'image/jpeg' }));
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
