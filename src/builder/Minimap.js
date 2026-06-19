/**
 * Minimap.js — schematic top-down floor-plan of the rooms.
 *
 * Rooms are nodes, hotspot links are edges, the current room is highlighted, and
 * clicking a node navigates to it. Positions come from the auto-link bearings
 * (each hotspot's `dir`): we lay rooms out in the (x,z) plane with a spanning
 * tree, placing each linked room along its bearing azimuth and aligning each
 * panorama's arbitrary yaw via the reciprocal hotspot. Directions are accurate;
 * distances are schematic (monocular panoramas carry no metric scale). Rooms with
 * no links are dropped into a tray row at the bottom.
 */

const EDGE = 1.0;                       // unit edge length (schematic)
const az = (d) => Math.atan2(d.z, d.x); // azimuth, matches the viewer convention

export default class Minimap {
  constructor(canvas, onSelect) {
    this.canvas = canvas;
    this.onSelect = onSelect;
    this._nodes = [];                   // { id, name, x, y } in canvas px
    canvas.addEventListener('click', (e) => this._onClick(e));
  }

  // scenes: [{id,name,hotspots:[{dir,target}]}], currentId. Returns true if drawn.
  update(scenes, currentId) {
    if (!scenes || scenes.length < 2) return false;
    this._currentId = currentId;
    const layout = this._layout(scenes);
    this._draw(scenes, layout, currentId);
    return true;
  }

  // spanning-tree layout in world (x,z); returns id -> {x, z, placed}
  _layout(scenes) {
    const byId = new Map(scenes.map(s => [s.id, s]));
    const ids = new Set(scenes.map(s => s.id));
    const pos = {}, yaw = {}, placed = {};
    // adjacency limited to scenes in this set
    const edges = (s) => s.hotspots.filter(h => h.target && ids.has(h.target));

    // roots: start from the current/first; BFS each connected component
    const order = [this._currentId, ...scenes.map(s => s.id)].filter(id => ids.has(id));
    for (const root of order) {
      if (pos[root]) continue;
      pos[root] = { x: 0, z: 0 }; yaw[root] = 0; placed[root] = true;
      const q = [root];
      while (q.length) {
        const p = q.shift();
        for (const h of edges(byId.get(p))) {
          const c = h.target;
          if (pos[c]) continue;
          const aGlobal = az(h.dir) + yaw[p];
          pos[c] = { x: pos[p].x + Math.cos(aGlobal) * EDGE, z: pos[p].z + Math.sin(aGlobal) * EDGE };
          placed[c] = true;
          // align c's yaw using its reciprocal hotspot (c -> p should be aGlobal+π)
          const back = edges(byId.get(c)).find(hb => hb.target === p);
          yaw[c] = back ? (aGlobal + Math.PI) - az(back.dir) : yaw[p];
          q.push(c);
        }
      }
    }
    return pos;
  }

  _draw(scenes, pos, currentId) {
    const cv = this.canvas, ctx = cv.getContext('2d');
    const W = cv.width = cv.clientWidth, H = cv.height = cv.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const linked = scenes.filter(s => pos[s.id] && (s.hotspots.some(h => h.target) ||
      scenes.some(o => o.hotspots.some(h => h.target === s.id))));
    const tray = scenes.filter(s => !linked.includes(s));

    // fit linked nodes into the upper area with padding
    const pad = 22, top = 14;
    const bottomH = tray.length ? 34 : 8;
    this._nodes = [];
    if (linked.length) {
      const xs = linked.map(s => pos[s.id].x), zs = linked.map(s => pos[s.id].z);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const spanX = (maxX - minX) || 1, spanZ = (maxZ - minZ) || 1;
      const areaW = W - pad * 2, areaH = H - top - bottomH - pad;
      const sc = Math.min(areaW / spanX, areaH / spanZ);
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const map = (s) => ({
        x: W / 2 + (pos[s.id].x - cx) * sc,
        y: top + (H - top - bottomH) / 2 + (pos[s.id].z - cz) * sc,
      });
      // edges
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5;
      linked.forEach(s => {
        const a = map(s);
        s.hotspots.forEach(h => {
          const t = linked.find(o => o.id === h.target);
          if (!t) return;
          const b = map(t);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        });
      });
      linked.forEach(s => { const m = map(s); this._nodes.push({ id: s.id, name: s.name, ...m }); });
    }
    // unlinked tray row
    tray.forEach((s, i) => {
      const x = pad + (i + 0.5) * ((W - pad * 2) / Math.max(1, tray.length));
      this._nodes.push({ id: s.id, name: s.name, x, y: H - bottomH / 2 - 2 });
    });

    // draw nodes
    this._nodes.forEach(n => {
      const cur = n.id === currentId;
      ctx.beginPath(); ctx.arc(n.x, n.y, cur ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = cur ? '#4f8cff' : 'rgba(255,255,255,.85)';
      ctx.fill();
      if (cur) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    });
  }

  _onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 16 * 16;
    this._nodes.forEach(n => {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bd) { bd = d; best = n; }
    });
    if (best && best.id !== this._currentId && this.onSelect) this.onSelect(best.id);
  }
}
