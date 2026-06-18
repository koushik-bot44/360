/**
 * TourStore.js — tour data model + persistence.
 *
 * A tour is a set of scenes (each = one panoramic image) connected by hotspots
 * (white dots). Stored in localStorage so it survives reloads, and can be
 * exported to / imported from a self-contained .json file (images embedded as
 * data URLs) for sharing.
 */
import { idbSet, idbGet, idbDelete, idbAll } from './idb';

const LS_KEY = 'vt_tours';        // legacy localStorage key (migrated on first load)
let _migrated = false;

function uid(prefix) {
  // no Date.now()/Math.random reliance needed here, but fine in the browser
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

export default class TourStore {
  constructor(tour) {
    this.tour = tour || {
      id: uid('tour'),
      title: 'My Virtual Tour',
      details: { description: '', amenities: '' },
      floors: ['Ground Floor'],
      startScene: null,
      scenes: [],
    };
    if (!this.tour.details) this.tour.details = { description: '', amenities: '' };
    // migrate older tours that predate floors
    if (!this.tour.floors || !this.tour.floors.length) this.tour.floors = ['Ground Floor'];
    this.tour.scenes.forEach(s => { if (!s.floor) s.floor = this.tour.floors[0]; });
  }

  // ---- floors ----
  getFloors() { return this.tour.floors || ['Ground Floor']; }
  addFloor(name) {
    name = (name || '').trim();
    if (!name || this.tour.floors.includes(name)) return name;
    this.tour.floors.push(name);
    return name;
  }
  renameFloor(oldName, newName) {
    newName = (newName || '').trim();
    if (!newName) return;
    const i = this.tour.floors.indexOf(oldName);
    if (i >= 0) this.tour.floors[i] = newName;
    this.tour.scenes.forEach(s => { if (s.floor === oldName) s.floor = newName; });
  }
  removeFloor(name) {
    if (this.tour.floors.length <= 1) return;
    this.tour.floors = this.tour.floors.filter(f => f !== name);
    const fallback = this.tour.floors[0];
    this.tour.scenes.forEach(s => { if (s.floor === name) s.floor = fallback; });
  }
  setSceneFloor(sceneId, floor) { const s = this.getScene(sceneId); if (s) s.floor = floor; }
  scenesOnFloor(floor) { return this.tour.scenes.filter(s => s.floor === floor); }

  // ---- scenes ----
  addScene(name, image, floor) {
    const scene = {
      id: uid('scn'),
      name: name || `Scene ${this.tour.scenes.length + 1}`,
      image,
      floor: floor || this.tour.floors[0],
      hotspots: [],
    };
    this.tour.scenes.push(scene);
    if (!this.tour.startScene) this.tour.startScene = scene.id;
    return scene;
  }

  removeScene(sceneId) {
    this.tour.scenes = this.tour.scenes.filter(s => s.id !== sceneId);
    // drop hotspots pointing at the removed scene
    this.tour.scenes.forEach(s => { s.hotspots = s.hotspots.filter(h => h.target !== sceneId); });
    if (this.tour.startScene === sceneId) {
      this.tour.startScene = this.tour.scenes[0] ? this.tour.scenes[0].id : null;
    }
  }

  getScene(sceneId) { return this.tour.scenes.find(s => s.id === sceneId); }

  renameScene(sceneId, name) { const s = this.getScene(sceneId); if (s) s.name = name; }

  setStart(sceneId) { this.tour.startScene = sceneId; }

  // ---- hotspots ----
  addHotspot(sceneId, dir, target, label) {
    const s = this.getScene(sceneId);
    if (!s) return null;
    const h = { id: uid('hot'), dir: { x: dir.x, y: dir.y, z: dir.z }, target: target || null, label: label || '' };
    s.hotspots.push(h);
    return h;
  }

  updateHotspot(sceneId, hotspotId, patch) {
    const s = this.getScene(sceneId);
    if (!s) return;
    const h = s.hotspots.find(x => x.id === hotspotId);
    if (h) Object.assign(h, patch);
  }

  removeHotspot(sceneId, hotspotId) {
    const s = this.getScene(sceneId);
    if (s) s.hotspots = s.hotspots.filter(h => h.id !== hotspotId);
  }

  // ---- persistence (IndexedDB, async) ----
  async save() {
    this.tour.updatedAt = Date.now();
    try {
      await idbSet(this.tour.id, this.tour);
    } catch (e) {
      console.error('Save failed (storage quota?):', e);
      throw e;
    }
  }

  async delete() { try { await idbDelete(this.tour.id); } catch (e) { /* ignore */ } }

  // one-time import of any tours that were saved in localStorage before the
  // move to IndexedDB
  static async _migrate() {
    if (_migrated) return;
    _migrated = true;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const map = JSON.parse(raw) || {};
      for (const id of Object.keys(map)) {
        if (!(await idbGet(id))) await idbSet(id, map[id]);
      }
      localStorage.removeItem(LS_KEY); // migrated; free the space
    } catch (e) { /* ignore */ }
  }

  static async all() {
    await TourStore._migrate();
    const list = await idbAll();
    const map = {};
    list.forEach((t) => { if (t && t.id) map[t.id] = t; });
    return map;
  }

  static async load(id) {
    await TourStore._migrate();
    const t = await idbGet(id);
    return t ? new TourStore(t) : null;
  }

  static async loadLatest() {
    const all = await TourStore.all();
    const tours = Object.values(all);
    if (!tours.length) return null;
    tours.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return new TourStore(tours[0]);
  }

  // ---- export / import ----
  toJSON() { return JSON.stringify(this.tour, null, 2); }

  download() {
    const blob = new Blob([this.toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (this.tour.title || 'tour').replace(/\s+/g, '_').toLowerCase() + '.tour.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  static fromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.scenes) throw new Error('Not a valid tour file');
          if (!data.id) data.id = uid('tour');
          resolve(new TourStore(data));
        } catch (e) { reject(e); }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }
}

export { uid };
