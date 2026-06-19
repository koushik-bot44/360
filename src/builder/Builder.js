/**
 * Builder.js — the "Create a Tour" experience.
 *
 * Upload panoramic photos → each becomes a scene → click on a photo to drop a
 * white dot → choose which scene that dot leads to → preview → export / share.
 */
import PanoViewer from './PanoViewer';
import TourStore from './TourStore';
import Capture from './Capture';
import Minimap from './Minimap';

const $ = (id) => document.getElementById(id);

// Local panorama-stitching backend (FastAPI). Override at runtime by setting
// localStorage 'panoBackend' (e.g. if you run uvicorn on another port/host).
const PANO_BACKEND = (typeof localStorage !== 'undefined' && localStorage.getItem('panoBackend'))
  || 'http://localhost:8000';

export default class Builder {
  constructor() {
    this.viewer = new PanoViewer($('pano-canvas'));
    this.currentSceneId = null;
    this.placing = false;
    this.activeFloor = null;
    this.capture = new Capture((result) => this._onCaptured(result));
    this.minimap = new Minimap($('minimap'), (id) => this._onMinimapSelect(id));
    this._boot();
  }

  // ---------- floor-plan minimap ----------
  _renderMinimap() {
    const wrap = $('minimap-wrap');
    if (!this.store || !this.currentSceneId) { wrap.style.display = 'none'; return; }
    const cur = this.store.getScene(this.currentSceneId);
    const rooms = this.store.scenesOnFloor(cur ? cur.floor : this.activeFloor);
    if (rooms.length < 2) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';          // visible first so the canvas has a size
    this.minimap.update(rooms, this.currentSceneId);
  }

  _onMinimapSelect(id) {
    if (document.body.classList.contains('play-mode')) this._playLoad(id);
    else this.selectScene(id);
  }

  // storage (IndexedDB) loads asynchronously
  async _boot() {
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const tourUrl = params.get('tour');

    if (tourUrl) { this._loadFromUrl(tourUrl); return; }

    if (viewId) {
      const store = await TourStore.load(viewId);
      if (store) { this.store = store; this._wireGlobal(); this._enterPlay(true); return; }
    }

    this.store = (await TourStore.loadLatest()) || new TourStore();
    this._wire();
    this._wireGlobal();
    this.refresh();
    if (this.store.tour.scenes.length) this.selectScene(this.store.tour.scenes[0].id);
    else this._emptyHint(true);
  }

  // ---------- wiring ----------
  _wireGlobal() {
    window.addEventListener('resize', () => this.viewer.resize());
    this.viewer.onPlace = (dir) => this._onPlace(dir);
    this.viewer.onHotspot = (data) => this._onHotspotClick(data);
    // play-mode controls (also needed when booting from a shared link)
    $('play-info-btn').addEventListener('click', () => $('play-info').classList.toggle('hidden'));
    $('play-info-close').addEventListener('click', () => $('play-info').classList.add('hidden'));
  }

  _wire() {
    $('upload-input').addEventListener('change', (e) => this._onUpload(e.target.files));
    $('add-photos-btn').addEventListener('click', () => $('upload-input').click());
    $('empty-upload-btn').addEventListener('click', () => $('upload-input').click());

    $('stitch-input').addEventListener('change', (e) => this._onStitchPhotos(e.target.files));
    $('stitch-photos-btn').addEventListener('click', () => $('stitch-input').click());
    $('empty-stitch-btn').addEventListener('click', () => $('stitch-input').click());

    $('guided-capture-btn').addEventListener('click', () => this._startCapture());
    $('empty-guided-btn').addEventListener('click', () => this._startCapture());

    $('autolink-btn').addEventListener('click', () => this._autoLinkRooms());

    $('add-floor-btn').addEventListener('click', () => {
      const name = prompt('Floor name? (e.g. First Floor, Basement)');
      if (!name) return;
      this.activeFloor = this.store.addFloor(name);
      this._persist();
      this._renderFloors();
      this._renderScenes();
    });

    $('add-hotspot-btn').addEventListener('click', () => this._togglePlacing());
    $('preview-btn').addEventListener('click', () => this._enterPlay(false));
    $('exit-play-btn').addEventListener('click', () => this._exitPlay());

    $('export-btn').addEventListener('click', () => { this._persist(); this.store.download(); });
    $('share-btn').addEventListener('click', () => this._share());

    $('import-input').addEventListener('change', (e) => this._onImport(e.target.files[0]));
    $('import-btn').addEventListener('click', () => $('import-input').click());

    $('tour-title').addEventListener('input', (e) => { this.store.tour.title = e.target.value; this._persist(); });
    $('tour-desc').addEventListener('input', (e) => { this.store.tour.details.description = e.target.value; this._persist(); });
    $('tour-amenities').addEventListener('input', (e) => { this.store.tour.details.amenities = e.target.value; this._persist(); });
  }

  // ---------- upload ----------
  // Upload 360° expects a full equirectangular image (~2:1). We measure each
  // file's aspect ratio and warn when it looks like an ordinary flat photo —
  // those wrap/stretch on the sphere; the user should stitch instead.
  _onUpload(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let pending = list.length;
    let lastScene = null;
    const notPano = [];   // names that aren't ~2:1

    const done = () => {
      if (--pending > 0) return;
      this._persist();
      this.refresh();
      if (lastScene) this.selectScene(lastScene.id);
      this._emptyHint(false);
      if (notPano.length) {
        const note = $('stitch-note');
        const which = notPano.length === 1 ? `“${notPano[0]}” doesn’t` : `${notPano.length} images don’t`;
        note.textContent = `⚠ ${which} look like a 360° panorama (not ~2:1) — they’ll appear stretched on the sphere. Use 🧩 Stitch photos for ordinary photos, or upload a 2:1 equirectangular image.`;
        note.classList.remove('hidden');
        setTimeout(() => note.classList.add('hidden'), 11000);
      }
    };

    list.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const name = file.name.replace(/\.[^.]+$/, '');
        const img = new Image();
        const add = (ratio) => {
          if (ratio && (ratio < 1.8 || ratio > 2.2)) notPano.push(name);
          lastScene = this.store.addScene(name, dataUrl, this.activeFloor);
          done();
        };
        img.onload = () => add(img.naturalWidth / img.naturalHeight);
        img.onerror = () => add(null);   // can't measure → add anyway
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- panorama stitching (backend) ----------
  // Shared by the file-picker ("Stitch photos") and the guided capture flow.
  // photos = array of File/Blob (overlapping shots). On success the resulting
  // panorama is added as a room scene and shown immediately.
  async _stitchPanorama(photos, roomName) {
    const list = Array.from(photos || []);
    const note = $('stitch-note');
    const show = (msg) => { note.textContent = msg; note.classList.remove('hidden'); };
    if (!list.length) return;
    show(list.length < 6
      ? `Only ${list.length} photos — stitching usually needs 10–20 overlapping shots. Trying anyway…`
      : `Stitching ${list.length} photos into a panorama…`);

    const form = new FormData();
    list.forEach((f, i) => form.append('files', f, f.name || `shot_${i}.jpg`));

    let data;
    try {
      const res = await fetch(`${PANO_BACKEND}/panorama`, { method: 'POST', body: form });
      data = await res.json();
    } catch (e) {
      show(`Could not reach the stitching backend at ${PANO_BACKEND}. Start it with: cd backend && uvicorn app.main:app --port 8000`);
      return;
    }

    if (!data.ok) {
      show(`Stitch failed: ${data.reason || 'unknown error'} (used ${data.num_images_used || 0}/${list.length} photos, ${data.num_matches || 0} matched features).`);
      return;
    }

    const name = roomName || `Room ${this.store.tour.scenes.length + 1}`;
    const scene = this.store.addScene(name, data.image, this.activeFloor);
    await this._persist();
    this.refresh();
    this.selectScene(scene.id);          // opens it in the sphere viewer
    this._emptyHint(false);
    const [w, h] = data.output_resolution || [];
    show(`✓ “${name}” added — ${data.num_images_used} photos, ${data.num_matches} matched features, ${w}×${h}px (vertical FOV ~${data.vertical_fov_deg}°). Drag to look around.`);
    setTimeout(() => note.classList.add('hidden'), 9000);
  }

  _onStitchPhotos(files) {
    this._stitchPanorama(files, null);
  }

  // ---------- auto-linking rooms ----------
  _updateAutolink() {
    const row = $('autolink-row');
    if (row) row.style.display = this.store.tour.scenes.length >= 2 ? 'flex' : 'none';
  }

  _ensureHotspot(from, to, dir) {
    if (from.hotspots.some(h => h.target === to.id)) return false;   // already linked
    this.store.addHotspot(from.id, dir, to.id, `Go to ${to.name}`);
    return true;
  }

  // Compare every pair of panoramas on the backend; where they overlap enough,
  // drop a hotspot in each that points toward the other room.
  async _autoLinkRooms() {
    const scenes = this.store.tour.scenes.filter(s => s.image);
    const note = $('autolink-note');
    const show = (m) => { note.textContent = m; note.classList.remove('hidden'); };
    if (scenes.length < 2) return;

    const pairs = [];
    for (let i = 0; i < scenes.length; i++)
      for (let j = i + 1; j < scenes.length; j++) pairs.push([scenes[i], scenes[j]]);

    const btn = $('autolink-btn');
    btn.disabled = true;
    show(`Linking ${scenes.length} rooms — comparing ${pairs.length} pair${pairs.length > 1 ? 's' : ''}…`);

    const blobOf = async (s) => (await fetch(s.image)).blob();
    let linked = 0, skipped = 0; const details = [];
    try {
      for (const [A, B] of pairs) {
        const fd = new FormData();
        fd.append('a', await blobOf(A), 'a.jpg');
        fd.append('b', await blobOf(B), 'b.jpg');
        const res = await fetch(`${PANO_BACKEND}/link`, { method: 'POST', body: fd });
        const data = await res.json();
        if (data.linked) {
          const added = this._ensureHotspot(A, B, data.dirA) | this._ensureHotspot(B, A, data.dirB);
          if (added) { linked++; details.push(`${A.name}↔${B.name} (${data.inliers})`); }
        } else { skipped++; }
      }
    } catch (e) {
      btn.disabled = false;
      show(`Could not reach the backend at ${PANO_BACKEND}. Start it: cd backend && uvicorn app.main:app --port 8000`);
      return;
    }

    btn.disabled = false;
    await this._persist();
    this.refresh();
    if (this.currentSceneId) {
      const cur = this.store.getScene(this.currentSceneId);
      if (cur) this.viewer.setHotspots(cur.hotspots);
    }
    this._renderMinimap();
    show(linked
      ? `✓ Linked ${linked} pair(s): ${details.join(', ')}.${skipped ? ` ${skipped} not connected (skipped).` : ''}`
      : 'No connected rooms found — panoramas need overlapping views to link.');
    setTimeout(() => note.classList.add('hidden'), 12000);
  }

  // ---------- AR-guided capture ----------
  _startCapture() {
    const name = prompt('Room name?', `Room ${this.store.tour.scenes.length + 1}`);
    if (name === null) return;
    this.capture.open(name || `Room ${this.store.tour.scenes.length + 1}`);
  }

  // called by Capture when the ring is done → stitch the captured frames
  _onCaptured(result) {
    if (!result || !result.panoMode || !result.frames || !result.frames.length) return;
    this._stitchPanorama(result.frames, result.roomName);
  }

  _onImport(file) {
    if (!file) return;
    TourStore.fromFile(file).then((store) => {
      this.store = store;
      this._persist();
      this.refresh();
      const first = this.store.tour.scenes[0];
      if (first) this.selectScene(first.id);
      this._emptyHint(!first);
    }).catch(() => alert('Could not read that file — make sure it is a .tour.json export.'));
  }

  // ---------- scenes ----------
  selectScene(sceneId) {
    this.currentSceneId = sceneId;
    const scene = this.store.getScene(sceneId);
    if (!scene) return;
    this._setPlacing(false);
    this.viewer.mode = 'view';
    this.activeFloor = scene.floor;
    this.viewer.loadPanorama(scene.image).then(() => {
      this.viewer.setHotspots(scene.hotspots);
    });
    this._renderFloors();
    this._renderScenes();
    this._renderHotspots();
    this._renderMinimap();
    $('current-scene-name').textContent = scene.name;
  }

  _renderFloors() {
    const floors = this.store.getFloors();
    if (!this.activeFloor || !floors.includes(this.activeFloor)) this.activeFloor = floors[0];
    const wrap = $('floor-pills');
    wrap.innerHTML = '';
    floors.forEach((f) => {
      const count = this.store.scenesOnFloor(f).length;
      const pill = document.createElement('button');
      pill.className = 'floor-pill' + (f === this.activeFloor ? ' active' : '');
      pill.textContent = `${f} (${count})`;
      pill.addEventListener('click', () => { this.activeFloor = f; this._renderFloors(); this._renderScenes(); });
      pill.addEventListener('dblclick', () => {
        const nn = prompt('Rename floor', f);
        if (nn) { this.store.renameFloor(f, nn); this.activeFloor = nn.trim(); this._persist(); this._renderFloors(); this._renderScenes(); }
      });
      wrap.appendChild(pill);
    });
  }

  _renderScenes() {
    const wrap = $('scene-list');
    wrap.innerHTML = '';
    const floors = this.store.getFloors();
    const scenes = this.store.scenesOnFloor(this.activeFloor);
    if (!scenes.length) {
      wrap.innerHTML = '<div class="muted small" style="padding:6px 2px">No rooms on this floor yet. Upload a 360° photo to add one.</div>';
    }
    scenes.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'scene-item' + (s.id === this.currentSceneId ? ' active' : '');
      const isStart = this.store.tour.startScene === s.id;
      const floorOpts = floors.map(f => `<option value="${this._esc(f)}" ${s.floor === f ? 'selected' : ''}>${this._esc(f)}</option>`).join('');
      el.innerHTML = `
        <img class="scene-thumb" src="${s.image}" alt="">
        <div class="scene-meta">
          <div class="scene-name">${this._esc(s.name)}</div>
          <div class="scene-sub">${s.hotspots.length} hotspot${s.hotspots.length === 1 ? '' : 's'}${isStart ? ' · start' : ''}</div>
          <select class="scene-floor" title="Move to floor">${floorOpts}</select>
        </div>
        <div class="scene-actions">
          <button class="mini ${isStart ? 'on' : ''}" data-act="start" title="Set as starting room">★</button>
          <button class="mini" data-act="del" title="Delete room">✕</button>
        </div>`;
      el.querySelector('.scene-thumb').addEventListener('click', () => this.selectScene(s.id));
      el.querySelector('.scene-name').addEventListener('click', () => this.selectScene(s.id));
      el.querySelector('.scene-floor').addEventListener('change', (ev) => {
        this.store.setSceneFloor(s.id, ev.target.value); this._persist(); this._renderFloors(); this._renderScenes();
      });
      el.querySelector('[data-act="start"]').addEventListener('click', (ev) => {
        ev.stopPropagation(); this.store.setStart(s.id); this._persist(); this._renderScenes();
      });
      el.querySelector('[data-act="del"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete "${s.name}"?`)) return;
        this.store.removeScene(s.id); this._persist(); this.refresh();
        const next = this.store.scenesOnFloor(this.activeFloor)[0] || this.store.tour.scenes[0];
        if (next) this.selectScene(next.id); else { this._clearStage(); this._emptyHint(true); }
      });
      wrap.appendChild(el);
    });
  }

  // ---------- hotspots ----------
  _togglePlacing() { this._setPlacing(!this.placing); }

  _setPlacing(on) {
    if (on && !this.currentSceneId) return;
    this.placing = on;
    this.viewer.mode = on ? 'place' : 'view';
    $('add-hotspot-btn').classList.toggle('active', on);
    $('place-hint').classList.toggle('hidden', !on);
  }

  _onPlace(dir) {
    if (!this.currentSceneId) return;
    const h = this.store.addHotspot(this.currentSceneId, dir, null, '');
    this._persist();
    this.viewer.setHotspots(this.store.getScene(this.currentSceneId).hotspots);
    this._renderHotspots();
    this._setPlacing(false);
  }

  _renderHotspots() {
    const scene = this.store.getScene(this.currentSceneId);
    const wrap = $('hotspot-list');
    wrap.innerHTML = '';
    if (!scene) return;
    if (!scene.hotspots.length) {
      wrap.innerHTML = '<div class="muted small">No hotspots yet. Click “Add hotspot”, then click on the photo.</div>';
    }
    scene.hotspots.forEach((h, i) => {
      const row = document.createElement('div');
      row.className = 'hotspot-row';
      const options = this.store.tour.scenes
        .filter(s => s.id !== scene.id)
        .map(s => `<option value="${s.id}" ${h.target === s.id ? 'selected' : ''}>${this._esc(s.name)}</option>`)
        .join('');
      row.innerHTML = `
        <span class="dot-badge">${i + 1}</span>
        <select class="hs-target">
          <option value="">— leads to… —</option>
          ${options}
        </select>
        <input class="hs-label" placeholder="label (optional)" value="${this._esc(h.label || '')}">
        <button class="mini" data-act="del" title="Remove">✕</button>`;
      row.querySelector('.hs-target').addEventListener('change', (e) => {
        this.store.updateHotspot(scene.id, h.id, { target: e.target.value || null });
        this._persist(); this._renderScenes();
      });
      row.querySelector('.hs-label').addEventListener('input', (e) => {
        this.store.updateHotspot(scene.id, h.id, { label: e.target.value });
        this._persist();
      });
      row.querySelector('[data-act="del"]').addEventListener('click', () => {
        this.store.removeHotspot(scene.id, h.id);
        this._persist();
        this.viewer.setHotspots(scene.hotspots);
        this._renderHotspots(); this._renderScenes();
      });
      wrap.appendChild(row);
    });
  }

  // ---------- play / preview ----------
  _enterPlay(fromShare) {
    const startId = this.store.tour.startScene || (this.store.tour.scenes[0] && this.store.tour.scenes[0].id);
    if (!startId) { alert('Add at least one photo first.'); return; }
    document.body.classList.add('play-mode');
    this.viewer.mode = 'play';
    this._playLoad(startId);
    $('play-title').textContent = this.store.tour.title || 'Virtual Tour';
    $('exit-play-btn').classList.toggle('hidden', !!fromShare);
    this._renderPlayInfo();
    this._renderPlayFloors();
    // resize after the play-mode layout has actually applied (canvas goes fullscreen)
    this.viewer.resize();
    requestAnimationFrame(() => this.viewer.resize());
    setTimeout(() => this.viewer.resize(), 80);
  }

  _exitPlay() {
    document.body.classList.remove('play-mode');
    this.viewer.resize();
    if (this.currentSceneId) this.selectScene(this.currentSceneId);
  }

  _playLoad(sceneId) {
    const scene = this.store.getScene(sceneId);
    if (!scene) return;
    this.currentSceneId = sceneId;
    const c = $('pano-canvas');
    c.style.transition = 'opacity .35s'; c.style.opacity = '0.15';
    this.viewer.loadPanorama(scene.image).then(() => {
      // only show hotspots that actually lead somewhere
      this.viewer.setHotspots(scene.hotspots.filter(h => h.target));
      c.style.opacity = '1';
      $('play-scene-name').textContent = `${scene.name} · ${scene.floor}`;
    });
    this._renderPlayFloors();
    this._renderMinimap();
  }

  _renderPlayFloors() {
    const floors = this.store.getFloors().filter(f => this.store.scenesOnFloor(f).length);
    const wrap = $('play-floors');
    const cur = this.store.getScene(this.currentSceneId);
    wrap.innerHTML = '';
    if (floors.length < 2) return;   // only show when there's more than one floor
    floors.forEach((f) => {
      const b = document.createElement('button');
      b.className = 'play-floor' + (cur && cur.floor === f ? ' active' : '');
      b.textContent = f;
      b.addEventListener('click', () => {
        const first = this.store.scenesOnFloor(f)[0];
        if (first) this._playLoad(first.id);
      });
      wrap.appendChild(b);
    });
  }

  _onHotspotClick(data) {
    if (this.viewer.mode !== 'play') return;
    if (data && data.target) this._playLoad(data.target);
  }

  _renderPlayInfo() {
    const d = this.store.tour.details || {};
    $('play-info-title').textContent = this.store.tour.title || 'Virtual Tour';
    $('play-info-desc').textContent = d.description || 'No description provided.';
    const am = (d.amenities || '').split(',').map(s => s.trim()).filter(Boolean);
    const wrap = $('play-info-amenities');
    wrap.innerHTML = am.length ? am.map(a => `<span class="chip">${this._esc(a)}</span>`).join('') : '';
    $('play-info-btn').classList.toggle('hidden', !(d.description || am.length));
  }

  // ---------- share ----------
  async _share() {
    await this._persist();   // ensure it's written before the link is used
    const link = `${location.origin}${location.pathname}?view=${this.store.tour.id}`;
    const note = $('share-note');
    navigator.clipboard?.writeText(link).then(() => {
      note.textContent = 'Preview link copied! (opens on this browser). For others, use Export and host the file.';
      note.classList.remove('hidden');
    }).catch(() => {
      note.textContent = link;
      note.classList.remove('hidden');
    });
  }

  _loadFromUrl(url) {
    fetch(url).then(r => r.json()).then((data) => {
      this.store = new TourStore(data);
      this._wireGlobal();
      this._enterPlay(false);          // show the Exit button
      const exit = $('exit-play-btn');
      exit.textContent = '← Home';
      exit.onclick = () => { location.href = '/'; };   // leave the demo
    }).catch(() => {
      document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">Could not load that tour.</p>';
    });
  }

  // ---------- helpers ----------
  refresh() {
    $('tour-title').value = this.store.tour.title || '';
    $('tour-desc').value = (this.store.tour.details && this.store.tour.details.description) || '';
    $('tour-amenities').value = (this.store.tour.details && this.store.tour.details.amenities) || '';
    this._renderFloors();
    this._renderScenes();
    this._renderHotspots();
    this._updateAutolink();
  }

  _persist() {
    return this.store.save().catch((e) => {
      const note = $('share-note');
      note.textContent = 'Could not save — storage may be full. Export your tour to keep it.';
      note.classList.remove('hidden');
      setTimeout(() => note.classList.add('hidden'), 6000);
    });
  }
  _clearStage() { this.currentSceneId = null; this.viewer.clearHotspots(); this.viewer.sphereMat.map = null; this.viewer.sphereMat.color.set(0x111111); this.viewer.sphereMat.needsUpdate = true; }
  _emptyHint(on) { $('empty-state').classList.toggle('hidden', !on); }
  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
}
