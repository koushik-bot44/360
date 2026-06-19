"""Render overlapping photos taken by ROTATING in place — the correct input for
panorama stitching (pure rotation, shared optical center, no parallax).

Contrast with make_synthetic_room.py (which TRANSLATES the camera for SfM). Here
the camera stays at one point and only its yaw changes, so the photos are related
by a pure rotation and stitch into a seamless 360° panorama.

Usage:
  python scripts/make_synthetic_pano.py <out_dir> [num_photos] [pitch_deg]

num_photos controls overlap: 360/num_photos = yaw step. With ~80° horizontal FOV,
12 photos (30° step) ≈ 60% overlap (good); 4 photos (90° step) ≈ 0% overlap (fails).
"""
import sys
from pathlib import Path

import numpy as np
import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.make_synthetic_room import _walls, _draw_wall, _look_at  # noqa: E402

W, H = 1024, 768
FOCAL = 560.0          # ~80° horizontal FOV
EYE = [0.0, 0.0, 0.0]  # fixed optical center (room is centered on origin)


_WALLS = None
_K = np.array([[FOCAL, 0, W / 2], [0, FOCAL, H / 2], [0, 0, 1]], float)


def _shot(yaw_deg, pitch_deg):
    global _WALLS
    if _WALLS is None:
        _WALLS = _walls()
    yaw, pitch = np.radians(yaw_deg), np.radians(pitch_deg)
    d = [np.cos(pitch) * np.cos(yaw), np.sin(pitch), np.cos(pitch) * np.sin(yaw)]
    R, t = _look_at(EYE, [EYE[0] + d[0], EYE[1] + d[1], EYE[2] + d[2]])
    img = np.zeros((H, W, 3), np.uint8)
    order = sorted(range(len(_WALLS)),
                   key=lambda w: -np.mean((np.array(_WALLS[w][0]).mean(0)) ** 2))
    for wi in order:
        _draw_wall(img, _K, R, t, _WALLS[wi][0], _WALLS[wi][1])
    return img


def render(out_dir: Path, n_photos=12, pitch_deg=0.0):
    """Single horizontal ring (back-compat)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(n_photos):
        cv2.imwrite(str(out_dir / f"shot_{i:02d}.jpg"),
                    _shot(360 * i / n_photos, pitch_deg), [cv2.IMWRITE_JPEG_QUALITY, 92])
    step = 360 / n_photos
    print(f"rendered {n_photos} photos -> {out_dir}  (yaw step {step:.0f}°, "
          f"~{max(0, 100*(1-step/80)):.0f}% horizontal overlap)")


def render_sphere(out_dir: Path):
    """Full-sphere capture: middle ring + upper/lower rings + zenith/nadir.
    Matches the AR-guided pattern (12 @ 0°, 8 @ ±55°, straight up/down)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    shots = [(360 * i / 12, 0) for i in range(12)]          # middle ring
    shots += [(360 * i / 8 + 22.5, 55) for i in range(8)]    # upper ring (offset)
    shots += [(360 * i / 8 + 22.5, -55) for i in range(8)]   # lower ring
    shots += [(0, 88), (0, -88)]                             # zenith + nadir
    for i, (yaw, pitch) in enumerate(shots):
        cv2.imwrite(str(out_dir / f"shot_{i:02d}.jpg"),
                    _shot(yaw, pitch), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"rendered {len(shots)} photos (full sphere: 12 mid + 8 up + 8 down + 2 poles) -> {out_dir}")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "pano_capture"
    if len(sys.argv) > 2 and sys.argv[2] == "sphere":
        render_sphere(out)
    else:
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
        pitch = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
        render(out, n, pitch)
