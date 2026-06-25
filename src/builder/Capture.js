/**
 * Capture.js — AR-guided FULL-SPHERE panorama capture (discrete auto-snap).
 *
 * Shows target dots at fixed yaw/pitch DIRECTIONS around you. Aim the next dot
 * (a card) into the centre box; once it's aligned, level and steady, a hold ring
 * fills and it AUTO-SNAPS one sharp photo for that spot, marks it done, and moves
 * to the next. This deliberate "take a picture at each spot" flow (vs. a continuous
 * sweep) gives the stitcher SHARP, well-spaced photos at clean angles — no motion
 * blur, no glitchy mid-swing compass readings, far fewer frames — which is exactly
 * the seed the backend wants. Each photo is named by the yaw/pitch it was shot at
 * (y..._p...), so POST /panorama can seed the Hugin solve and stitch it crisply.
 *
 * Quality gates: blur rejection (variance of Laplacian), level check (phone roll),
 * walk detection (accelerometer). Dots are world-locked via the live orientation
 * quaternion, so they stay pinned to their real point in the room.
 */
import * as THREE from 'three';

// Full-sphere target set (30): dense middle ring (12 @ 30°) for ~45% overlap with
// a ~55° portrait lens; upper/lower rings (8 each @ 45°, tilted ±40°) that overlap
// both each other and the middle ring; plus zenith + nadir. More points = more
// overlap = the stitcher gets a denser, better-constrained solve (this is the
// ~30-shot density 360 capture apps use). Each is a fixed yaw/pitch DIRECTION.
const TARGETS = [
  ...Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, label: `${i * 30}°`, az: i * 30, el: 0 })),
  ...Array.from({ length: 8 }, (_, i) => ({ key: `u${i}`, label: '↑ up', az: i * 45 + 22, el: 40 })),
  ...Array.from({ length: 8 }, (_, i) => ({ key: `d${i}`, label: '↓ down', az: i * 45, el: -40 })),
  { key: 'zen', label: '⤒ ceiling', az: 0, el: 88 },
  { key: 'nad', label: '⤓ floor', az: 0, el: -88 },
];

const MIN_DONE = 16;       // enable Finish once the ring + a few up/down are done
const FOV = 65;            // assumed phone horizontal FOV (deg) for projecting dots
const LOCK_ANGLE = 10;     // deg between aim and target to count as "on target" (tighter)
const ROLL_MAX = 7;        // deg of phone roll allowed before we refuse to capture
                           // (strict like 360 Photo Cam: tilted frames ruin the
                           // horizon/alignment, so we won't snap until it's level)
const BLUR_MIN = 45;       // laplacian-variance threshold (deliberate shots are sharp)
const WALK_ACCEL = 2.2;    // m/s² (gravity-excluded) sustained ⇒ "you're walking"
const AUTO_MS = 1100;      // hold aligned + steady this long → auto-snap (no early grabs)
const STEADY_SPEED = 1.6;  // max aim speed (deg/frame) to count as steady (stricter)
const Q_SMOOTH = 0.35;     // orientation slerp per frame — light, stays responsive
const DEG = Math.PI / 180;

const $ = (id) => document.getElementById(id);

// --- World-locked projection ------------------------------------------------
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
    this.az = 0; this.el = 0;
    this.hasOrientation = false;
    this.stream = null;
    this.raf = null;
    this._accelEMA = 0;
    this._walking = false;
    this._holdMs = 0;
    this._mkDom();
  }

  // ---------- lifecycle ----------
  async open(roomName) {
    this.roomName = roomName || 'Room';
    // fresh target set for this capture
    this._targets = TARGETS.map(t => ({ ...t, vec: vecFromAzEl(t.az, t.el),
      done: false, canvas: null, azShot: 0, elShot: 0 }));
    this._holdMs = 0;
    this._buildDots();
    $('cap-room-name').textContent = this.roomName;
    this.root.classList.remove('hidden');
    document.body.classList.add('capturing');
    this._toast('Aim each dot into the box, extend your arm, and hold steady — it snaps itself.');

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
      this._dev = { alpha: e.alpha, beta: e.beta || 0, gamma: e.gamma || 0 };
      this.hasOrientation = true;
    };
    this._onMotion = (e) => {
      const a = e.acceleration || {};
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
    const dt = this._lastNow ? now - this._lastNow : 16;
    this._lastNow = now;

    // 1) camera orientation quaternion (sensors on phone, drag on desktop)
    const qt = this._qTarget || (this._qTarget = new THREE.Quaternion());
    if (this.hasOrientation && this._dev) {
      deviceQuaternion(qt, this._dev.alpha, this._dev.beta, this._dev.gamma, this._screenAngle());
    } else {
      lookQuaternion(qt, this.az, this.el);
    }
    if (!this._q) this._q = qt.clone();
    else this._q.slerp(qt, this.hasOrientation ? Q_SMOOTH : 1);

    // 2) aim direction → az/el
    const fwd = (this._fwd || (this._fwd = new THREE.Vector3())).set(0, 0, -1).applyQuaternion(this._q);
    if (this.hasOrientation) {
      this.az = (Math.atan2(fwd.x, -fwd.z) / DEG + 360) % 360;
      this.el = Math.asin(Math.max(-1, Math.min(1, fwd.y))) / DEG;
    }
    this.needle.style.transform = `rotate(${this.az}deg)`;

    // phone roll (0 = level); pole shots are exempt (roll ill-defined near poles)
    const rightV = (this._rightV || (this._rightV = new THREE.Vector3())).set(1, 0, 0).applyQuaternion(this._q);
    const roll = Math.asin(Math.max(-1, Math.min(1, rightV.y))) / DEG;
    const level = Math.abs(this.el) > 65 || Math.abs(roll) < ROLL_MAX;

    // aim speed → steadiness (don't snap mid-swing; it'd be blurry)
    const prevFwd = this._prevFwd || (this._prevFwd = fwd.clone());
    const speed = fwd.angleTo(prevFwd) / DEG;
    this._prevFwd.copy(fwd);
    const steady = speed < STEADY_SPEED;

    // 3) nearest UN-shot target to the current aim
    let nextT = null, nextD = Infinity, doneCount = 0;
    for (const t of this._targets) {
      if (t.done) { doneCount++; continue; }
      const d = fwd.angleTo(t.vec) / DEG;
      if (d < nextD) { nextD = d; nextT = t; }
    }
    const onTarget = !!nextT && nextD <= LOCK_ANGLE;
    const aligned = this.hasOrientation && onTarget && level && steady && !this._walking;
    this._aligned = aligned;

    // 4) draw the dots (world-locked) and centre box / hold state
    this._renderDots(nextT);
    this.box.classList.toggle('locked', aligned);
    this.box.classList.toggle('tilt', this.hasOrientation && onTarget && !level && !this._walking);
    this.box.classList.toggle('warn', !!this._walking);

    // 5) auto-snap: hold aligned + steady for AUTO_MS, then capture this target
    if (aligned) {
      this._holdMs += dt;
      const p = Math.min(1, this._holdMs / AUTO_MS);
      this.hold.classList.add('active');
      this.hold.style.background =
        `conic-gradient(rgba(52,199,89,.9) ${p * 360}deg, rgba(255,255,255,.14) 0)`;
      if (this._holdMs >= AUTO_MS && nextT) {
        if (this._snap(nextT)) { this._flash(); }
        this._holdMs = 0;
      }
    } else {
      this._holdMs = 0;
      this.hold.classList.remove('active');
    }

    // 6) progress + guidance
    const total = this._targets.length;
    const enough = doneCount >= MIN_DONE;
    $('cap-progress').textContent = `${doneCount}/${total}`;
    $('cap-finish').disabled = !enough;
    $('cap-finish').textContent = enough
      ? `Finish & stitch (${doneCount})`
      : `Capture the dots — ${doneCount}/${total}`;
    $('cap-shoot').disabled = !nextT;

    let msg;
    if (this._walking) msg = '⚠ Stand still — turn in place, don\'t walk';
    else if (!this.hasOrientation) msg = 'Allow motion access, then aim at the dots';
    else if (!nextT) msg = '✓ All spots captured — press Finish to stitch';
    else if (onTarget && !level) msg = roll > 0 ? '↺ Hold the phone level' : '↻ Hold the phone level';
    else if (aligned) msg = '✓ Hold steady — capturing…';
    else if (onTarget && !steady) msg = 'Hold steady on the dot';
    else {
      const dAz = ((nextT.az - this.az + 540) % 360) - 180;
      const dEl = nextT.el - this.el;
      const dir = Math.abs(dAz) >= Math.abs(dEl) ? (dAz > 0 ? '→ turn right' : '← turn left')
                                                 : (dEl > 0 ? '↑ tilt up' : '↓ tilt down');
      msg = `Aim the card into the box — ${dir}`;
    }
    $('cap-guidance').textContent = msg;
  }

  // ---------- dots ----------
  _buildDots() {
    this.dotsLayer.innerHTML = '';
    this._dotEls = this._targets.map((t) => {
      const d = document.createElement('div');
      d.className = 'cap-dot pending';
      const s = document.createElement('span');
      s.textContent = t.label;
      d.appendChild(s);
      this.dotsLayer.appendChild(d);
      return d;
    });
  }

  // project each target through the live orientation and place its dot on screen
  _renderDots(nextT) {
    const qInv = (this._qInv || (this._qInv = new THREE.Quaternion())).copy(this._q).invert();
    const { thx, thy } = this._fovTan();
    const v = this._dv || (this._dv = new THREE.Vector3());
    for (let i = 0; i < this._targets.length; i++) {
      const t = this._targets[i], el = this._dotEls[i];
      v.copy(t.vec).applyQuaternion(qInv);          // into camera space (looks −z)
      let show = false, x = 0, y = 0, edge = false;
      if (v.z < -0.05) {
        x = (v.x / -v.z) / thx;                      // −1..1 across the half-FOV
        y = (v.y / -v.z) / thy;
        if (Math.abs(x) <= 1.35 && Math.abs(y) <= 1.35) {
          show = true;
          edge = Math.abs(x) > 1 || Math.abs(y) > 1;
        }
      }
      let cls = 'cap-dot ';
      if (t.done) cls += 'done';
      else if (t === nextT) cls += 'current' + (this._aligned ? ' aligned' : '');
      else cls += 'pending' + (edge ? ' edge' : '');
      el.className = cls;
      if (show) {
        el.style.display = 'flex';
        el.style.left = `${Math.max(3, Math.min(97, 50 + 50 * x))}%`;
        el.style.top = `${Math.max(6, Math.min(94, 50 - 50 * y))}%`;
      } else {
        el.style.display = 'none';
      }
    }
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

  // capture one sharp frame for a target; returns true if kept
  _snap(target) {
    const frame = this._grabFrame();
    if (!frame) return false;
    if (this._sharpness(frame) < BLUR_MIN) return false;   // blurry — wait for a steadier frame
    target.canvas = frame;
    target.azShot = Math.round(this.az);
    target.elShot = Math.round(this.el);
    target.done = true;
    return true;
  }

  // manual shutter — snap the nearest target if we're reasonably on it
  shoot() {
    if (this._walking) { this._toast('You moved — turn in place, then aim at the dot.', true); return; }
    let nextT = null, nextD = Infinity;
    for (const t of this._targets) {
      if (t.done) continue;
      const v = vecFromAzEl(this.az, this.el);
      const d = v.angleTo(t.vec) / DEG;
      if (d < nextD) { nextD = d; nextT = t; }
    }
    if (!nextT) return;
    if (nextD > LOCK_ANGLE * 1.8) { this._toast('Aim closer to the highlighted dot first.', true); return; }
    if (this._snap(nextT)) this._flash();
    else this._toast('Hold steadier — that frame was blurry.', true);
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
    const done = this._targets.filter(t => t.done && t.canvas);
    if (done.length < MIN_DONE) {
      this._toast(`Capture more spots first (have ${done.length}).`, true);
      return;
    }
    const roomName = this.roomName;
    const meta = done.map(t => ({ yaw: t.azShot, pitch: t.elShot }));
    this.close();
    const tag = (v) => (v < 0 ? 'm' : 'p') + String(Math.abs(Math.round(v))).padStart(3, '0');
    Promise.all(done.map(t => new Promise(res =>
      t.canvas.toBlob(b => res(b ? { blob: b, yaw: t.azShot, pitch: t.elShot } : null), 'image/jpeg', 0.9))))
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
    this.box = $('cap-box');
    this.needle = $('cap-needle');
    this.hold = $('cap-hold');
    this.dotsLayer = $('cap-dots');
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
