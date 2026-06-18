/**
 * Capture.js — camera-guided room capture.
 *
 * Opens the device camera, shows a center crosshair and guidance dots for the
 * directions that still need a photo. On a phone with motion sensors the dots
 * track your orientation and the crosshair "locks" onto the nearest target;
 * everywhere else (incl. desktop) a manual direction grid is used instead.
 *
 * Output: an object of face canvases { front, back, left, right, up, down }
 * (plus any captured diagonals) handed to onComplete().
 */

// label, azimuth (deg, 0=front, clockwise), elevation (deg)
const TARGETS = [
  { key: 'front',      label: 'Front',       az: 0,   el: 0,  face: true },
  { key: 'frontRight', label: 'Front Right', az: 45,  el: 0 },
  { key: 'right',      label: 'Right',       az: 90,  el: 0,  face: true },
  { key: 'backRight',  label: 'Back Right',  az: 135, el: 0 },
  { key: 'back',       label: 'Back',        az: 180, el: 0,  face: true },
  { key: 'backLeft',   label: 'Back Left',   az: 225, el: 0 },
  { key: 'left',       label: 'Left',        az: 270, el: 0,  face: true },
  { key: 'frontLeft',  label: 'Front Left',  az: 315, el: 0 },
  { key: 'up',         label: 'Up',          az: 0,   el: 85, face: true },
  { key: 'down',       label: 'Down',        az: 0,   el: -85, face: true },
];

const FOV = 65;            // assumed phone h-fov for projecting dots
const LOCK_ANGLE = 11;     // deg crosshair must be within target to lock
const BLUR_MIN = 55;       // laplacian-variance threshold

const $ = (id) => document.getElementById(id);
function angDiff(a, b) { let d = ((a - b + 540) % 360) - 180; return d; }

export default class Capture {
  constructor(onComplete) {
    this.onComplete = onComplete;
    this.captured = {};        // key -> canvas
    this.az = 0; this.el = 0;
    this.hasOrientation = false;
    this.stream = null;
    this.raf = null;
    this._mkDom();
  }

  // ---------- lifecycle ----------
  async open(roomName) {
    this.captured = {};
    this.roomName = roomName || 'Room';
    $('cap-room-name').textContent = this.roomName;
    this.root.classList.remove('hidden');
    document.body.classList.add('capturing');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
    } catch (e) {
      this._fail('Camera access was blocked. Allow camera permission (and use HTTPS on a phone), then try again.');
      return;
    }

    await this._initOrientation();
    this._renderTargets();
    this._loop();
  }

  close() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    window.removeEventListener('deviceorientation', this._onOrient);
    this.root.classList.add('hidden');
    document.body.classList.remove('capturing');
  }

  // ---------- orientation ----------
  async _initOrientation() {
    this._onOrient = (e) => {
      if (e.alpha == null) return;
      this.hasOrientation = true;
      // crude back-camera pointing approximation
      this.az = (360 - e.alpha) % 360;
      this.el = Math.max(-90, Math.min(90, (e.beta || 90) - 90));
    };
    try {
      const DOE = window.DeviceOrientationEvent;
      if (DOE && typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission();   // iOS — needs the tap that opened capture
        if (res === 'granted') window.addEventListener('deviceorientation', this._onOrient);
      } else if (DOE) {
        window.addEventListener('deviceorientation', this._onOrient);
      }
    } catch (e) { /* manual mode */ }
    // give sensors a beat to report
    setTimeout(() => { this.manual = !this.hasOrientation; this.root.classList.toggle('manual-mode', this.manual); }, 700);
  }

  // ---------- render loop ----------
  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    const remaining = TARGETS.filter(t => !this.captured[t.key]);

    // nearest remaining target by angular distance
    let nearest = null, nearestDist = Infinity;
    remaining.forEach(t => {
      const daz = angDiff(t.az, this.az);
      const dele = t.el - this.el;
      const dist = Math.hypot(daz, dele);
      if (dist < nearestDist) { nearestDist = dist; nearest = t; }
      const dot = this.dots[t.key];
      // project onto screen
      const x = 50 + (daz / FOV) * 50;
      const y = 50 - (dele / FOV) * 50;
      const onscreen = x > -5 && x < 105 && y > -5 && y < 105;
      dot.style.display = onscreen ? 'flex' : 'none';
      dot.style.left = x + '%';
      dot.style.top = y + '%';
    });

    // states
    TARGETS.forEach(t => {
      const dot = this.dots[t.key];
      dot.classList.remove('current', 'done', 'pending');
      if (this.captured[t.key]) dot.classList.add('done');
      else if (t === nearest) dot.classList.add('current');
      else dot.classList.add('pending');
    });

    const locked = nearest && this.hasOrientation && nearestDist < LOCK_ANGLE;
    this.crosshair.classList.toggle('locked', !!locked);
    this._target = nearest;
    $('cap-guidance').textContent = nearest
      ? (locked ? `Hold steady — capture ${nearest.label}` : `Rotate to aim at: ${nearest.label}`)
      : 'All directions captured!';
    $('cap-progress').textContent = `${Object.keys(this.captured).length}/${TARGETS.length}`;
    $('cap-shoot').disabled = !nearest || (this.hasOrientation && !locked);

    // compass needle
    this.needle.style.transform = `rotate(${this.az}deg)`;
  }

  // ---------- capture ----------
  _grabFrame() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) return null;
    const s = Math.min(vw, vh);
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, 1024, 1024);
    return c;
  }

  shoot(forKey) {
    const target = forKey ? TARGETS.find(t => t.key === forKey) : this._target;
    if (!target) return;
    const frame = this._grabFrame();
    if (!frame) return;

    const sharp = this._sharpness(frame);
    if (sharp < BLUR_MIN) {
      this._toast(`Looks blurry (score ${Math.round(sharp)}). Hold still and retake ${target.label}.`, true);
      return;
    }
    this.captured[target.key] = frame;
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
      const v = -4 * g[i] + g[i-1] + g[i+1] + g[i-n] + g[i+n];
      lap[i] = v; mean += v;
    }
    mean /= (n * n);
    let varr = 0;
    for (let i = 0; i < n * n; i++) { const dv = lap[i] - mean; varr += dv * dv; }
    return varr / (n * n);
  }

  _finish() {
    const coverage = TARGETS.filter(t => t.face).every(t => this.captured[t.key]);
    if (!coverage) { this._toast('Some core directions are missing — capture them to finish.', true); return; }
    const faces = {};
    ['front','back','left','right','up','down'].forEach(k => { faces[k] = this.captured[k]; });
    const quality = this._roomQuality();
    this.close();
    this.onComplete && this.onComplete({ faces, roomName: this.roomName, quality });
  }

  _roomQuality() {
    // simple 0-100 score from how many captured + average not-blurry margin
    const done = Object.keys(this.captured).length;
    return Math.round((done / TARGETS.length) * 100);
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

  _mkDom() {
    this.root = $('capture-overlay');
    this.video = $('cap-video');
    this.crosshair = $('cap-crosshair');
    this.needle = $('cap-needle');
    this.dotsLayer = $('cap-dots');
    this.dots = {};
    TARGETS.forEach(t => {
      const d = document.createElement('div');
      d.className = 'cap-dot pending';
      d.innerHTML = `<span>${t.label}</span>`;
      this.dotsLayer.appendChild(d);
      this.dots[t.key] = d;
    });
    $('cap-shoot').addEventListener('click', () => this.shoot());
    $('cap-close').addEventListener('click', () => this.close());
    $('cap-finish').addEventListener('click', () => this._finish());
  }

  _toast(msg, warn) {
    const el = $('cap-toast');
    el.textContent = msg;
    el.classList.toggle('warn', !!warn);
    el.classList.remove('hidden');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  _fail(msg) { this._toast(msg, true); setTimeout(() => this.close(), 3200); }
}
