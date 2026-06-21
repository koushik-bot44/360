/**
 * Capture.js — AR-guided FULL-SPHERE panorama capture.
 *
 * Opens the device camera and overlays reticle dots at the yaw/pitch positions
 * still to be shot. The pattern is three rings + the two poles for full 360×180
 * coverage (no dark floor/ceiling): a dense middle ring (12 @ 0°, every 30°), an
 * upper ring (6 @ +45°), a lower ring (6 @ −45°), and zenith/nadir — 26 targets.
 * To stay clean (like a guided street-view capture) only the NEXT target dot is
 * shown at a time; aim it into the crosshair and — once aligned and steady for a
 * moment — it AUTO-captures (no tapping). Each target is a DIRECTION on a sphere
 * (yaw/pitch); we project it through the phone's live orientation quaternion, so
 * the dot stays WORLD-LOCKED — pinned to its real point on the wall (like VR
 * geometry) instead of sliding with the screen. On a phone the dot tracks your
 * motion (DeviceOrientationEvent); on desktop you drag to look.
 * Quality gates: blur rejection (variance of Laplacian) and walk detection
 * (accelerometer warns if you translate instead of rotating). When enough is
 * captured it hands an ordered list of JPEG blobs (named by yaw/pitch) to
 * onComplete for stitching → POST /panorama → full-sphere equirectangular.
 */
import * as THREE from 'three';

// Full-sphere target set (26): a DENSE middle ring (every 30°) + upper/lower
// rings (every 60°) + explicit zenith/nadir. Tight spacing matters because a
// phone in portrait has only ~50° horizontal FOV — at 45° spacing consecutive
// shots barely overlapped (~10%), so the ring wouldn't close and the panorama
// collapsed. 30° spacing gives ~40% overlap → the stitcher can lock the loop.
const TARGETS = [
  ...Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, label: `${i * 30}°`, az: i * 30, el: 0 })),
  ...Array.from({ length: 8 }, (_, i) => ({ key: `u${i}`, label: '↑', az: i * 45 + 22, el: 45 })),
  ...Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, label: '↓', az: i * 45, el: -45 })),
  { key: 'zen0', label: '⤒ up', az: 0, el: 87 },
  { key: 'zen1', label: '⤒ up', az: 180, el: 87 },
  { key: 'nad0', label: '⤓ down', az: 0, el: -87 },
  { key: 'nad1', label: '⤓ down', az: 180, el: -87 },
];

const MIN_SHOTS = 8;       // the middle ring alone already gives a usable panorama
const FOV = 65;            // assumed phone horizontal FOV (deg) for projecting dots
const LOCK_ANGLE = 12;     // deg between aim and target to lock
const ROLL_MAX = 10;       // deg of phone roll allowed before we refuse to capture
                           // (level shots stitch far better — like the real app)
const BLUR_MIN = 55;       // laplacian-variance threshold
const WALK_ACCEL = 2.2;    // m/s² (gravity-excluded) sustained ⇒ "you're walking"
const STICKY_MARGIN = 18;  // deg another target must beat the current one by to take over
const AUTO_MS = 900;       // hold aligned & still this long → auto-capture (sharper)
const Q_SMOOTH = 0.35;     // orientation slerp per frame — light, so it stays responsive
const DEG = Math.PI / 180;
// continuous-capture ("paint the sphere") tuning
const GRAB_ANGLE = 14;     // grab a frame once aim has moved this far from EVERY shot
const COVER_RADIUS = 22;   // a coverage cell counts as filled if a shot lies within this
const COVERAGE_TARGET = 86; // % of the sphere covered before Finish enables
const STEADY_SPEED = 1.6;  // max aim speed (deg/frame) to grab — blocks fast swipes (blur)

const $ = (id) => document.getElementById(id);

// --- World-locked projection ------------------------------------------------
// A panorama assumes you rotate in place, so each target is a fixed DIRECTION on
// a unit sphere (yaw=az, pitch=el). We build the phone's orientation quaternion
// and perspective-project the direction onto the screen, so the dot stays pinned
// to its real-world point (including phone roll) — not just slid linearly.
const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // screen→world (−90° about X)
const _m = new THREE.Matrix4();
const _origin = new THREE.Vector3(0, 0, 0);
const _up = new THREE.Vector3(0, 1, 0);

function vecFromAzEl(az, el) {                 // (deg) → unit direction on the sphere
  const a = az * DEG, ce = Math.cos(el * DEG);
  return new THREE.Vector3(ce * Math.sin(a), Math.sin(el * DEG), -ce * Math.cos(a));
}
function targetVec(t) { return t._vec || (t._vec = vecFromAzEl(t.az, t.el)); }

// Roughly equal-area sphere tessellation — the "coverage map" cells that light up
// green as your sweep paints them. Fewer cells per ring near the poles.
const COVERAGE_CELLS = (() => {
  const cells = [];
  for (const el of [-78, -52, -26, 0, 26, 52, 78]) {
    const n = Math.max(1, Math.round(14 * Math.cos(el * DEG)));
    for (let i = 0; i < n; i++) {
      const az = i * 360 / n;
      cells.push({ az, el, vec: vecFromAzEl(az, el), _cov: false });
    }
  }
  cells.push({ az: 0, el: 90, vec: vecFromAzEl(0, 90), _cov: false });
  cells.push({ az: 0, el: -90, vec: vecFromAzEl(0, -90), _cov: false });
  return cells;
})();

// device orientation (deg) → camera world quaternion (W3C / THREE convention)
function deviceQuaternion(out, alpha, beta, gamma, screen) {
  _euler.set(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ');
  out.setFromEuler(_euler);
  out.multiply(_q1);                                       // camera looks out the back
  out.multiply(_q0.setFromAxisAngle(_zee, -screen * DEG)); // compensate screen rotation
  return out;
}
// manual / desktop fallback: aim the camera at an az/el coming from drag
function lookQuaternion(out, az, el) {
  _m.lookAt(_origin, vecFromAzEl(az, el), _up);
  return out.setFromRotationMatrix(_m);
}

export default class Capture {
  constructor(onComplete) {
    this.onComplete = onComplete;
    this._shots = [];          // continuous capture: [{ canvas, az, el, vec, t }]
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
    this._shots = [];
    COVERAGE_CELLS.forEach(c => { c._cov = false; });
    this.roomName = roomName || 'Room';
    this._t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    $('cap-room-name').textContent = this.roomName;
    this.root.classList.remove('hidden');
    document.body.classList.add('capturing');

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
      // Just store the raw reading; the quaternion is built and smoothed in the
      // loop (smoothing the full orientation, not a single noisy compass angle).
      this._dev = { alpha: e.alpha, beta: e.beta || 0, gamma: e.gamma || 0 };
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

  // current screen-rotation angle (deg) so projection holds when the phone rolls
  _screenAngle() {
    return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  }
  // half-FOV tangents (h from FOV, v from the overlay's aspect) for projection
  _fovTan() {
    const r = this.dotsLayer.getBoundingClientRect();
    const aspect = (r.width && r.height) ? r.height / r.width : 16 / 9;
    const thx = Math.tan((FOV * DEG) / 2);
    return { thx, thy: thx * aspect };
  }

  // ---------- render loop ----------
  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();

    // 1) Camera orientation quaternion (sensors on a phone, drag on desktop),
    //    slerped toward the latest reading. Smoothing the WHOLE orientation —
    //    not one noisy compass angle — is what stops the dot from shaking.
    const qt = this._qTarget || (this._qTarget = new THREE.Quaternion());
    if (this.hasOrientation && this._dev) {
      deviceQuaternion(qt, this._dev.alpha, this._dev.beta, this._dev.gamma, this._screenAngle());
    } else {
      lookQuaternion(qt, this.az, this.el);            // manual: aim from drag az/el
    }
    if (!this._q) this._q = qt.clone();
    else this._q.slerp(qt, this.hasOrientation ? Q_SMOOTH : 1);

    // 2) Aim direction → az/el (drives the compass needle; in sensor mode keeps
    //    this.az/el in sync with the smoothed quaternion).
    const fwd = (this._fwd || (this._fwd = new THREE.Vector3())).set(0, 0, -1).applyQuaternion(this._q);
    if (this.hasOrientation) {
      this.az = (Math.atan2(fwd.x, -fwd.z) / DEG + 360) % 360;
      this.el = Math.asin(Math.max(-1, Math.min(1, fwd.y))) / DEG;
    }
    this.needle.style.transform = `rotate(${this.az}deg)`;

    // Phone roll (0 = level): the camera's right vector lifts off horizontal when
    // you tilt the phone left/right. Like the real app, we refuse to capture a
    // tilted frame — level shots stitch far better. Roll is ill-defined when
    // aiming near the poles, so the pole shots are exempt.
    const rightV = (this._rightV || (this._rightV = new THREE.Vector3())).set(1, 0, 0).applyQuaternion(this._q);
    const roll = Math.asin(Math.max(-1, Math.min(1, rightV.y))) / DEG;

    // 3) CONTINUOUS CAPTURE — paint the sphere as you sweep. Grab a frame whenever
    //    the aim has moved GRAB_ANGLE from EVERY frame we already have: a dense,
    //    overlapping sweep instead of discrete dots. Blurry/tilted/walking skipped.
    // angular speed of the aim — only grab when moving slowly enough to be sharp
    // (continuous frames grabbed mid-swing carry motion blur).
    const prevFwd = this._prevFwd || (this._prevFwd = fwd.clone());
    const speed = fwd.angleTo(prevFwd) / DEG;
    this._prevFwd.copy(fwd);
    const steady = speed < STEADY_SPEED;

    const level = Math.abs(this.el) > 65 || Math.abs(roll) < ROLL_MAX;    // poles exempt
    if (this.hasOrientation && !this._walking && level && steady && !this._grabBusy) {
      let minD = Infinity;
      for (let i = 0; i < this._shots.length; i++) {
        const d = fwd.angleTo(this._shots[i].vec) / DEG;
        if (d < minD) minD = d;
        if (minD <= GRAB_ANGLE) break;
      }
      if (minD > GRAB_ANGLE) {
        this._grabBusy = true;
        this._grabContinuous();
        this._grabBusy = false;
      }
    }

    // 4) Coverage map — which sphere cells now have a nearby shot; nearest gap.
    let covered = 0, gap = null, gapD = Infinity;
    for (let i = 0; i < COVERAGE_CELLS.length; i++) {
      const c = COVERAGE_CELLS[i];
      c._cov = false;
      for (let j = 0; j < this._shots.length; j++) {
        if (c.vec.angleTo(this._shots[j].vec) / DEG < COVER_RADIUS) { c._cov = true; break; }
      }
      if (c._cov) covered++;
      else { const d = fwd.angleTo(c.vec) / DEG; if (d < gapD) { gapD = d; gap = c; } }
    }
    const pct = Math.round(covered / COVERAGE_CELLS.length * 100);
    this._renderCoverage();
    $('cap-progress').textContent = `${pct}%`;
    this.box.classList.toggle('warn', !!this._walking);
    this.box.classList.toggle('tilt', !!(this.hasOrientation && !level && !this._walking));

    let msg;
    if (this._walking) msg = '⚠ Stay in one spot — turn in place, don\'t walk';
    else if (!this.hasOrientation) msg = 'Allow motion access, then sweep slowly';
    else if (!gap) msg = '✓ Sphere complete — press Finish to stitch';
    else if (!level) msg = roll > 0 ? '↺ Hold level — tilting right' : '↻ Hold level — tilting left';
    else if (!steady) msg = '🐢 Sweep slower for sharp shots';
    else {
      const dAz = ((gap.az - this.az + 540) % 360) - 180;
      const dEl = gap.el - this.el;
      const dir = Math.abs(dAz) >= Math.abs(dEl) ? (dAz > 0 ? '→ right' : '← left')
                                                 : (dEl > 0 ? '↑ up' : '↓ down');
      msg = `Sweep ${dir} to fill the gap`;
    }
    $('cap-guidance').textContent = msg;

    const enough = pct >= COVERAGE_TARGET;
    $('cap-shoot').disabled = false;
    $('cap-finish').disabled = !enough;
    $('cap-finish').textContent = enough ? `Finish & stitch (${this._shots.length})` : `Keep sweeping — ${pct}%`;
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

  // manual grab (the CAPTURE button) — frames are also grabbed automatically as
  // you sweep, so this is just for topping up a spot.
  shoot() {
    if (this._walking) { this._toast('You moved — turn in place; it captures as you sweep.', true); return; }
    if (this._grabContinuous()) this._flash();
    else this._toast('Hold a little steadier — that frame was blurry.', true);
  }

  // grab the current frame into the sweep if it's sharp; returns true if kept
  _grabContinuous() {
    const frame = this._grabFrame();
    if (!frame) return false;
    if (this._sharpness(frame) < BLUR_MIN) return false;   // skip blur; catch a steadier frame
    const az = Math.round(this.az), el = Math.round(this.el);
    this._shots.push({
      canvas: frame, az, el, vec: vecFromAzEl(az, el),
      t: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - this._t0),
    });
    if (this._shots.length > 140) this._shots.shift();     // hard safety cap
    return true;
  }

  // draw the flattened coverage map: green cells = painted, white dot = where you aim
  _renderCoverage() {
    const ctx = this._covCtx;
    if (!ctx) return;
    const w = this._covCanvas.width, h = this._covCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);
    const X = (az) => ((az % 360 + 360) % 360) / 360 * w;
    const Y = (el) => (90 - el) / 180 * h;          // +90 top, 0 = horizon (middle), -90 bottom

    // reference lines so "middle = horizon" is unmistakable
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();   // horizon
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '8px sans-serif';
    ctx.fillText('up', 3, 9); ctx.fillText('floor', 3, h - 3);

    for (let i = 0; i < COVERAGE_CELLS.length; i++) {
      const c = COVERAGE_CELLS[i];
      ctx.beginPath();
      ctx.arc(X(c.az), Y(c.el), 2.6, 0, Math.PI * 2);
      ctx.fillStyle = c._cov ? '#34c759' : 'rgba(255,255,255,0.22)';
      ctx.fill();
    }
    // where you're aiming (white, outlined)
    ctx.beginPath();
    ctx.arc(X(this.az), Y(this.el), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
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
    const shots = this._shots.slice();
    if (shots.length < MIN_SHOTS) {
      this._toast(`Sweep more of the room first (have ${shots.length}).`, true);
      return;
    }
    const roomName = this.roomName;
    // metadata sidecar (yaw/pitch/timestamp per shot) — kept for ordering / future use
    const meta = shots.map(s => ({ yaw: s.az, pitch: s.el, t: s.t }));
    this.close();
    const tag = (v) => (v < 0 ? 'm' : 'p') + String(Math.abs(v)).padStart(3, '0');
    Promise.all(shots.map(s => new Promise(res =>
      s.canvas.toBlob(b => res(b ? { blob: b, yaw: s.az, pitch: s.el } : null), 'image/jpeg', 0.9))))
      .then(items => {
        const frames = items.filter(Boolean).map(it =>
          new File([it.blob], `y${tag(it.yaw)}_p${tag(it.pitch)}.jpg`, { type: 'image/jpeg' }));
        this.onComplete && this.onComplete({ panoMode: true, frames, meta, roomName });
      });
  }

  // ---------- dom ----------
  _mkDom() {
    this.root = $('capture-overlay');
    this.video = $('cap-video');
    this.crosshair = $('cap-crosshair');
    this.box = $('cap-box');
    this.needle = $('cap-needle');
    this.hold = $('cap-hold');
    this._covCanvas = $('cap-coverage');
    this._covCtx = this._covCanvas ? this._covCanvas.getContext('2d') : null;
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

  _flash() {
    this.root.classList.add('cap-flash');
    setTimeout(() => this.root.classList.remove('cap-flash'), 160);
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
