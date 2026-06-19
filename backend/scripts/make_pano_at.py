"""Render a full equirectangular panorama from an arbitrary position inside the
synthetic room (ray-cast the textured box). Used to validate room auto-linking:
two panoramas at known positions give a ground-truth bearing between them.

Convention matches the viewer (src/builder/PanoViewer.js):
  column j -> azimuth a = 2*pi*j/W   (a = atan2(z, x))
  row i    -> polar f   = pi*i/H      (from +y)
  direction = (cos a * sin f, cos f, sin a * sin f)

Usage:  python scripts/make_pano_at.py <out.jpg> [x] [y] [z]
"""
import sys
from pathlib import Path

import numpy as np
import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.make_synthetic_room import _texture, ROOM  # noqa: E402

# one texture per face: +x,-x,+y,-y,+z,-z
_FACE_TEX = [_texture(s) for s in (1, 2, 3, 4, 5, 6)]


def pixel_dirs(W, H):
    j = np.arange(W); i = np.arange(H)
    a = 2 * np.pi * j / W                       # azimuth per column
    f = np.pi * (i + 0.5) / H                   # polar per row
    A, F = np.meshgrid(a, f)                     # (H,W)
    s = np.sin(F)
    return np.stack([np.cos(A) * s, np.cos(F), np.sin(A) * s], axis=-1)  # (H,W,3)


def render_pano_at(pos, W=1024, H=512):
    pos = np.asarray(pos, float)
    D = pixel_dirs(W, H).reshape(-1, 3)         # (N,3) unit rays
    N = D.shape[0]
    R = ROOM
    best_t = np.full(N, np.inf)
    best_face = np.zeros(N, int)
    # 6 axis-aligned planes; pick the nearest positive hit per ray
    planes = [(0, +R, 0), (0, -R, 1), (1, +R, 2), (1, -R, 3), (2, +R, 4), (2, -R, 5)]
    for axis, val, face in planes:
        d = D[:, axis]
        with np.errstate(divide='ignore', invalid='ignore'):
            t = (val - pos[axis]) / d
            hit = pos + t[:, None] * D
        # inside the face bounds (other two axes within [-R,R]) and t>0
        others = [k for k in range(3) if k != axis]
        ok = (t > 1e-6) & (np.abs(hit[:, others[0]]) <= R + 1e-3) & \
             (np.abs(hit[:, others[1]]) <= R + 1e-3)
        take = ok & (t < best_t)
        best_t[take] = t[take]
        best_face[take] = face

    hit = pos + best_t[:, None] * D
    out = np.zeros((N, 3), np.uint8)
    for axis, val, face in planes:
        m = best_face == face
        if not m.any():
            continue
        others = [k for k in range(3) if k != axis]
        u = (hit[m][:, others[0]] + R) / (2 * R)
        v = (hit[m][:, others[1]] + R) / (2 * R)
        tex = _FACE_TEX[face]
        th, tw = tex.shape[:2]
        px = np.clip((u * (tw - 1)).astype(int), 0, tw - 1)
        py = np.clip((v * (th - 1)).astype(int), 0, th - 1)
        out[m] = tex[py, px]
    return out.reshape(H, W, 3)


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "pano_at.jpg"
    pos = [float(x) for x in sys.argv[2:5]] if len(sys.argv) >= 5 else [0, 0, 0]
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), render_pano_at(pos), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"rendered panorama at {pos} -> {out}")
