"""Render a textured synthetic room from a ring of cameras (with ground-truth poses).

Why: real COLMAP needs photos with (a) rich texture for SIFT features and (b)
parallax (translation) between views to triangulate. Flat color images can't be
reconstructed. This renders a box-shaped room whose walls carry high-frequency
texture, viewed from a ring of cameras at slightly different positions — so the
SfM pipeline has genuine, solvable geometry. It also writes the ground-truth
camera centers so a test can check what COLMAP recovered.

Usage:  python scripts/make_synthetic_room.py <out_dir> [num_cameras]
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

W, H = 960, 720                 # image size
FOCAL = 560.0                   # px (~80° horizontal FOV -> good overlap)
ROOM = 4.0                      # half-size of the room (walls at +/-ROOM)
RING_R = 2.3                    # camera ring radius — large baseline vs. wall
                                # distance gives strong parallax (real capture
                                # walks around; tiny rings are near-panoramic
                                # and reconstruct degenerately).
CAM_Y = 0.0                     # camera height (room centered on origin)


def _texture(seed, size=1024):
    """High-frequency, feature-rich texture (random blocks + noise + shapes)."""
    rng = np.random.default_rng(seed)
    small = rng.integers(0, 255, size=(32, 32, 3), dtype=np.uint8)
    tex = cv2.resize(small, (size, size), interpolation=cv2.INTER_NEAREST)
    noise = rng.integers(0, 60, size=(size, size, 3), dtype=np.uint8)
    tex = cv2.add(tex, noise)
    for _ in range(40):  # add shapes -> corners/blobs for SIFT
        c = tuple(int(x) for x in rng.integers(0, 255, 3))
        p = tuple(int(x) for x in rng.integers(0, size, 2))
        if rng.random() < 0.5:
            cv2.circle(tex, p, int(rng.integers(15, 60)), c, -1)
        else:
            q = tuple(int(x) for x in rng.integers(0, size, 2))
            cv2.rectangle(tex, p, q, c, int(rng.integers(2, 8)))
    return tex


def _walls():
    """4 walls + floor + ceiling as (corners[4x3], texture). Corners ordered to
    match texture (top-left, top-right, bottom-right, bottom-left)."""
    R = ROOM
    defs = [
        # +X wall
        ([[R, R, -R], [R, R, R], [R, -R, R], [R, -R, -R]], 1),
        # -X wall
        ([[-R, R, R], [-R, R, -R], [-R, -R, -R], [-R, -R, R]], 2),
        # +Z wall
        ([[-R, R, R], [R, R, R], [R, -R, R], [-R, -R, R]], 3),
        # -Z wall
        ([[R, R, -R], [-R, R, -R], [-R, -R, -R], [R, -R, -R]], 4),
        # floor (y=-R)
        ([[-R, -R, R], [R, -R, R], [R, -R, -R], [-R, -R, -R]], 5),
        # ceiling (y=+R)
        ([[-R, R, -R], [R, R, -R], [R, R, R], [-R, R, R]], 6),
    ]
    return [(np.array(c, float), _texture(s)) for c, s in defs]


def _look_at(eye, target, up=(0, 1, 0)):
    """Return R (world->camera) and t for a camera at eye looking at target.
    Camera looks down +z in its local frame (COLMAP convention)."""
    eye = np.array(eye, float); target = np.array(target, float)
    f = target - eye; f /= np.linalg.norm(f)          # forward (+z)
    up = np.array(up, float)
    r = np.cross(up, f); r /= np.linalg.norm(r)        # right (+x)
    u = np.cross(f, r)                                 # down-ish (+y)
    R = np.vstack([r, u, f])                           # world->camera rows
    t = -R @ eye
    return R, t


def _project(K, R, t, P):
    """World points (N,3) -> image (N,2) + camera-space z."""
    Pc = (R @ P.T + t[:, None]).T
    z = Pc[:, 2]
    uv = (K @ Pc.T).T
    uv = uv[:, :2] / np.where(z[:, None] == 0, 1e-9, z[:, None])
    return uv, z


def _draw_wall(img, K, R, t, corners, tex, grid=8, znear=0.05):
    """Render one textured wall by subdividing into a grid of cells and warping
    each cell whose 4 corners are fully in front of the camera. This handles
    walls that are only partially visible (edge-on / partly behind) without
    full polygon clipping, so diagonal views aren't dropped to black.

    corners order: TL, TR, BR, BL (matches texture orientation).
    """
    TL, TR, BR, BL = (np.array(c, float) for c in corners)
    th, tw = tex.shape[:2]
    H_img, W_img = img.shape[:2]

    def world_at(u, v):  # bilinear on the quad
        top = (1 - u) * TL + u * TR
        bot = (1 - u) * BL + u * BR
        return (1 - v) * top + v * bot

    for j in range(grid):
        for i in range(grid):
            u0, u1 = i / grid, (i + 1) / grid
            v0, v1 = j / grid, (j + 1) / grid
            quad = np.array([world_at(u0, v0), world_at(u1, v0),
                             world_at(u1, v1), world_at(u0, v1)])
            uv, z = _project(K, R, t, quad)
            if np.any(z <= znear):
                continue
            if np.any(~np.isfinite(uv)):
                continue
            # cull cells entirely off-screen
            if (uv[:, 0].max() < 0 or uv[:, 0].min() > W_img or
                    uv[:, 1].max() < 0 or uv[:, 1].min() > H_img):
                continue
            src = np.array([[u0 * tw, v0 * th], [u1 * tw, v0 * th],
                            [u1 * tw, v1 * th], [u0 * tw, v1 * th]], np.float32)
            Hm = cv2.getPerspectiveTransform(src, uv.astype(np.float32))
            warped = cv2.warpPerspective(tex, Hm, (W_img, H_img))
            mask = cv2.warpPerspective(np.full((th, tw), 255, np.uint8),
                                       Hm, (W_img, H_img))
            img[mask > 0] = warped[mask > 0]


def render(out_dir: Path, n_cams=16):
    out_dir.mkdir(parents=True, exist_ok=True)
    K = np.array([[FOCAL, 0, W / 2], [0, FOCAL, H / 2], [0, 0, 1]], float)
    walls = _walls()
    poses = []

    for i in range(n_cams):
        a = 2 * np.pi * i / n_cams
        eye = [RING_R * np.cos(a), CAM_Y, RING_R * np.sin(a)]
        # look ACROSS the room at the center: adjacent cameras then share almost
        # the same far-wall structure from different positions -> strong parallax
        # and dense matches (object-centric / turntable capture, the well-posed
        # case). Looking outward instead makes neighbours see disjoint walls and
        # the reconstruction collapses.
        target = [0.0, 0.0, 0.0]
        R, t = _look_at(eye, target)
        img = np.zeros((H, W, 3), np.uint8)

        # painter's algorithm: draw far walls first
        order = sorted(range(len(walls)),
                       key=lambda w: -np.mean((np.array(walls[w][0]).mean(0)
                                               - np.array(eye)) ** 2))
        for wi in order:
            corners, tex = walls[wi]
            _draw_wall(img, K, R, t, corners, tex)

        name = f"frame_{i:02d}.jpg"
        cv2.imwrite(str(out_dir / name), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        poses.append({"name": name, "center": eye})

    (out_dir / "ground_truth.json").write_text(json.dumps(poses, indent=2))
    print(f"rendered {n_cams} views -> {out_dir}")
    return poses


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/synthetic_room")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 16
    render(out, n)
