/**
 * Builder.js — the "Create a Tour" experience.
 *
 * Upload panoramic photos → each becomes a scene → click on a photo to drop a
 * white dot → choose which scene that dot leads to → preview → export / share.
 */
import PanoViewer from './PanoViewer';
import TourStore from './TourStore';
import Capture from './Capture';
import cubeToEquirect from './cubeToEquirect';

const $ = (id) => document.getElementById(id);

export default class Builder {
  constructor() {
    this.viewer = new PanoViewer($('pano-canvas'));
    this.currentSceneId = null;
    this.placing = false;
    this.capture = new Capture((result) => this._onCaptured(result));

    // boot into play mode if a ?view=<id> link was shared
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const tourUrl = params.get('tour');

    if (tourUrl) {
      this._loadFromUrl(tourUrl);
      return;
    }
    if (viewId) {
      const store = TourStore.load(viewId);
      if (store) { this.store = store; this._enterPlay(true); this._wireGlobal(); return; }
    }

    this.store = TourStore.loadLatest() || new TourStore();
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

    $('capture-room-btn').addEventListener('click', () => this._startCapture());
    $('empty-capture-btn').addEventListener('click', () => this._startCapture());

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
  _onUpload(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let pending = list.length;
    list.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const scene = this.store.addScene(file.name.replace(/\.[^.]+$/, ''), reader.result);
        pending--;
        if (pending === 0) {
          this._persist();
          this.refresh();
          this.selectScene(scene.id);
          this._emptyHint(false);
        }
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- camera capture ----------
  _startCapture() {
    const name = prompt('Room name?', `Room ${this.store.tour.scenes.length + 1}`);
    if (name === null) return;
    this.capture.open(name || `Room ${this.store.tour.scenes.length + 1}`);
  }

  _onCaptured(result) {
    if (!result || !result.faces) return;
    const note = $('share-note');
    note.textContent = 'Assembling your 360° room…';
    note.classList.remove('hidden');
    cubeToEquirect(result.faces).then((dataUrl) => {
      const scene = this.store.addScene(result.roomName, dataUrl);
      this._persist();
      this.refresh();
      this.selectScene(scene.id);
      this._emptyHint(false);
      note.textContent = `“${result.roomName}” added (coverage ${result.quality}%). Tip: drag to look — seams are expected from a phone capture.`;
      setTimeout(() => note.classList.add('hidden'), 5000);
    }).catch(() => {
      note.textContent = 'Could not assemble the room. Please try capturing again.';
      setTimeout(() => note.classList.add('hidden'), 4000);
    });
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
    this.viewer.loadPanorama(scene.image).then(() => {
      this.viewer.setHotspots(scene.hotspots);
    });
    this._renderScenes();
    this._renderHotspots();
    $('current-scene-name').textContent = scene.name;
  }

  _renderScenes() {
    const wrap = $('scene-list');
    wrap.innerHTML = '';
    this.store.tour.scenes.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'scene-item' + (s.id === this.currentSceneId ? ' active' : '');
      const isStart = this.store.tour.startScene === s.id;
      el.innerHTML = `
        <img class="scene-thumb" src="${s.image}" alt="">
        <div class="scene-meta">
          <div class="scene-name">${this._esc(s.name)}</div>
          <div class="scene-sub">${s.hotspots.length} hotspot${s.hotspots.length === 1 ? '' : 's'}${isStart ? ' · start' : ''}</div>
        </div>
        <div class="scene-actions">
          <button class="mini ${isStart ? 'on' : ''}" data-act="start" title="Set as starting scene">★</button>
          <button class="mini" data-act="del" title="Delete scene">✕</button>
        </div>`;
      el.querySelector('.scene-thumb').addEventListener('click', () => this.selectScene(s.id));
      el.querySelector('.scene-meta').addEventListener('click', () => this.selectScene(s.id));
      el.querySelector('[data-act="start"]').addEventListener('click', (ev) => {
        ev.stopPropagation(); this.store.setStart(s.id); this._persist(); this._renderScenes();
      });
      el.querySelector('[data-act="del"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete "${s.name}"?`)) return;
        this.store.removeScene(s.id); this._persist(); this.refresh();
        const next = this.store.tour.scenes[0];
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
    this.viewer.resize();
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
      $('play-scene-name').textContent = scene.name;
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
  _share() {
    this._persist();
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
      this._enterPlay(true);
    }).catch(() => {
      document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">Could not load that tour.</p>';
    });
  }

  // ---------- helpers ----------
  refresh() {
    $('tour-title').value = this.store.tour.title || '';
    $('tour-desc').value = (this.store.tour.details && this.store.tour.details.description) || '';
    $('tour-amenities').value = (this.store.tour.details && this.store.tour.details.amenities) || '';
    this._renderScenes();
    this._renderHotspots();
  }

  _persist() { this.store.save(); }
  _clearStage() { this.currentSceneId = null; this.viewer.clearHotspots(); this.viewer.sphereMat.map = null; this.viewer.sphereMat.color.set(0x111111); this.viewer.sphereMat.needsUpdate = true; }
  _emptyHint(on) { $('empty-state').classList.toggle('hidden', !on); }
  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
}
