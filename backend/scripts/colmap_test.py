"""Verify the REAL reconstruction engine recovers camera poses from photos.

Renders (if needed) a textured synthetic room with known ground-truth camera
centers, runs the actual pycolmap/COLMAP pipeline via colmap_runner, parses the
recovered poses, aligns them to ground truth with a similarity transform
(SfM is solved up to an unknown scale/rotation/translation), and reports RMSE.

Run from backend/:   python scripts/colmap_test.py
"""
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.pipeline import colmap_runner, poses as poses_mod  # noqa: E402
from scripts.make_synthetic_room import render  # noqa: E402


def umeyama(src, dst):
    """Similarity transform (s, R, t) mapping src->dst, plus aligned src & RMSE."""
    src = np.asarray(src); dst = np.asarray(dst)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    Sc, Dc = src - mu_s, dst - mu_d
    cov = Dc.T @ Sc / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[-1, -1] = -1
    R = U @ S @ Vt
    var_s = (Sc ** 2).sum() / len(src)
    s = np.trace(np.diag(D) @ S) / var_s
    t = mu_d - s * R @ mu_s
    aligned = (s * (R @ src.T).T) + t
    rmse = float(np.sqrt(((aligned - dst) ** 2).sum(1).mean()))
    return s, R, t, aligned, rmse


def main():
    img_dir = ROOT / "data" / "synthetic_room"
    if not (img_dir / "ground_truth.json").exists():
        render(img_dir, 16)
    gt = json.loads((img_dir / "ground_truth.json").read_text())
    gt_by_name = {g["name"]: np.array(g["center"], float) for g in gt}

    print(f"engine: {colmap_runner.engine_name()}  (available={colmap_runner.is_available()})")
    if colmap_runner.engine_name() == "mock":
        print("FAIL: no real engine (pycolmap / colmap CLI) available."); sys.exit(1)

    print(f"running reconstruction on {len(gt_by_name)} photos ...")
    t0 = time.time()
    model_dir = colmap_runner.run(img_dir, ROOT / "data" / "synthetic_room_colmap")
    nodes = poses_mod.parse_images_txt(model_dir)
    dt = time.time() - t0

    print(f"reconstruction took {dt:.1f}s")
    print(f"registered {len(nodes)} / {len(gt_by_name)} images")
    if len(nodes) < 3:
        print("FAIL: too few images registered to evaluate."); sys.exit(1)

    names = [n["name"] for n in nodes if n["name"] in gt_by_name]
    src = np.array([next(x["position"] for x in nodes if x["name"] == nm) for nm in names])
    dst = np.array([gt_by_name[nm] for nm in names])
    _, _, _, aligned, rmse = umeyama(src, dst)

    ring = np.linalg.norm(dst - dst.mean(0), axis=1).mean()  # ~ ring radius
    print(f"pose RMSE vs ground truth: {rmse:.4f} world units "
          f"({100 * rmse / ring:.1f}% of ring radius)")
    print("\nper-camera error (aligned):")
    for nm, a, d in zip(names, aligned, dst):
        print(f"  {nm}: recovered {np.round(a,2)}  truth {np.round(d,2)}  "
              f"err {np.linalg.norm(a-d):.3f}")

    ok = len(nodes) >= 0.75 * len(gt_by_name) and rmse < 0.15 * ring
    print("\n" + ("PASS — real engine recovered correct camera geometry."
                  if ok else "PARTIAL — registered/accuracy below target; see above."))
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
