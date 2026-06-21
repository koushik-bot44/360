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
const AUTO_MS = 650;       // hold aligned this long → auto-capture (hands-free)
const Q_SMOOTH = 0.35;     // orientation slerp per frame — light, so it stays responsive
const DEG = Math.PI / 180;

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
    const remaining = TARGETS.filter(t => !this.captured[t.key]);
    const done = TARGETS.length - remaining.length;
    $('cap-progress').textContent = `${done}/${TARGETS.length}`;

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
    const invQ = (this._invQ || (this._invQ = new THREE.Quaternion())).copy(this._q).invert();

    // Phone roll (0 = level): the camera's right vector lifts off horizontal when
    // you tilt the phone left/right. Like the real app, we refuse to capture a
    // tilted frame — level shots stitch far better. Roll is ill-defined when
    // aiming near the poles, so the pole shots are exempt.
    const rightV = (this._rightV || (this._rightV = new THREE.Vector3())).set(1, 0, 0).applyQuaternion(this._q);
    const roll = Math.asin(Math.max(-1, Math.min(1, rightV.y))) / DEG;

    // 3) Next target — STICKY, by TRUE angular distance between aim and target:
    //    keep the current one until it's captured, switching only when another
    //    is clearly (STICKY_MARGIN°) closer, so the dot never flickers between
    //    two near-equidistant targets ("too many dots").
    const angTo = (t) => fwd.angleTo(targetVec(t)) / DEG;
    let cur = (this._target && !this.captured[this._target.key]) ? this._target : null;
    let nearest = cur, nearestDist = cur ? angTo(cur) : Infinity;
    remaining.forEach(t => {
      if (t === cur) return;
      const d = angTo(t);
      if (d < nearestDist - (cur ? STICKY_MARGIN : 0)) { nearestDist = d; nearest = t; }
    });
    this._target = nearest;

    // 4) Project ONLY the active target through the camera → a world-locked dot
    //    pinned to its real point on the wall (perspective, with roll handled).
    const { thx, thy } = this._fovTan();
    const clamp = (v) => Math.max(6, Math.min(94, v));
    const vc = this._vc || (this._vc = new THREE.Vector3());
    TARGETS.forEach(t => {
      const dot = this.dots[t.key];
      if (!dot) return;
      if (t !== nearest) { dot.style.display = 'none'; return; }   // one dot at a time
      vc.copy(targetVec(t)).applyQuaternion(invQ);                 // → camera space
      let x, y, onscreen;
      if (vc.z < -1e-3) {                                          // in front of camera
        const ndcX = (vc.x / -vc.z) / thx, ndcY = (vc.y / -vc.z) / thy;
        x = 50 + ndcX * 50; y = 50 - ndcY * 50;
        onscreen = Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1;
      } else {                                                     // behind → ride the edge
        const a = Math.atan2(vc.y, vc.x);
        x = 50 + Math.cos(a) * 60; y = 50 - Math.sin(a) * 60;
        onscreen = false;
      }
      dot.style.display = 'flex';
      dot.style.left = clamp(x) + '%'; dot.style.top = clamp(y) + '%';
      dot.classList.remove('done', 'pending');
      dot.classList.toggle('current', true);
      dot.classList.toggle('edge', !onscreen);                     // riding the edge = "turn this way"
    });

    const level = Math.abs(this.el) > 65 || Math.abs(roll) < ROLL_MAX;  // poles exempt
    const aimed = nearest && nearestDist < LOCK_ANGLE && !this._walking;
    const locked = aimed && level;
    this.crosshair.classList.toggle('locked', !!locked);
    this.crosshair.classList.toggle('warn', !!this._walking);
    this.crosshair.classList.toggle('tilt', !!(aimed && !level));

    // Alignment box mirrors the crosshair state; the level line rotates with the
    // phone's roll (flat = straight) — at the poles roll is meaningless, so flat.
    this.box.classList.toggle('locked', !!locked);
    this.box.classList.toggle('warn', !!this._walking);
    this.box.classList.toggle('tilt', !!(aimed && !level));
    const showRoll = Math.abs(this.el) > 65 ? 0 : roll;
    this.level.style.transform = `translate(-50%, -50%) rotate(${-showRoll}deg)`;

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

    let msg;
    if (this._walking) msg = '⚠ Stay in one spot — rotate in place, don\'t walk';
    else if (!nearest) msg = 'All captured — press Finish to stitch';
    else if (locked) msg = 'Hold steady — capturing…';
    else if (aimed && !level) msg = roll > 0 ? '↺ Straighten up — tilting right' : '↻ Straighten up — tilting left';
    else if (!this.hasOrientation) msg = 'Drag to bring the dot into the crosshair';
    else {
      // Which way to move, in WORLD terms (yaw/pitch vs the aim direction) so the
      // hint stays correct even when the phone is rolled. Call out the dominant
      // axis, like the real capture apps ("← Turn left", "↑ Tilt up").
      const dAz = ((nearest.az - this.az + 540) % 360) - 180;   // +ve ⇒ target is to the right
      const dEl = nearest.el - this.el;                          // +ve ⇒ target is higher
      msg = Math.abs(dAz) >= Math.abs(dEl)
        ? (dAz > 0 ? '→ Turn right' : '← Turn left')
        : (dEl > 0 ? '↑ Tilt up' : '↓ Tilt down');
    }
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
    this.box = $('cap-box');
    this.level = $('cap-level');
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
