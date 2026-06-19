"""Generate example 'good' vs 'bad' capture contact sheets for CAPTURE_GUIDE.md,
plus the stitched outcome of each, so the guide can show what works.

Run from backend/:  python scripts/make_capture_examples.py
Outputs to docs/capture/ at the repo root.
"""
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.make_synthetic_pano import render as render_pano  # noqa: E402
from scripts.make_synthetic_room import render as render_room  # noqa: E402
from app.pipeline.stitch import stitch_panorama  # noqa: E402

OUT = ROOT.parent / "docs" / "capture"


def contact_sheet(paths, cols, label, color):
    thumbs = []
    for p in paths:
        im = cv2.imread(str(p))
        thumbs.append(cv2.resize(im, (220, 165)))
    rows = (len(thumbs) + cols - 1) // cols
    pad = 8
    cell_w, cell_h = 220 + pad, 165 + pad
    sheet = np.full((rows * cell_h + 40, cols * cell_w + pad, 3), 28, np.uint8)
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        y, x = 40 + r * cell_h + pad, c * cell_w + pad
        sheet[y:y + 165, x:x + 220] = t
    cv2.putText(sheet, label, (pad, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
    return sheet


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    # GOOD: 12 photos rotating in place, ~30° step (~62% overlap)
    good_dir = ROOT / "data" / "ex_good"
    render_pano(good_dir, 12)
    good = sorted(good_dir.glob("shot_*.jpg"))
    cv2.imwrite(str(OUT / "good_capture.jpg"),
                contact_sheet(good, 4, "GOOD: 12 photos, rotate in place, ~62% overlap", (120, 230, 120)))
    eq, dbg_good = stitch_panorama(good)
    if eq is not None:
        cv2.imwrite(str(OUT / "good_result.jpg"), eq, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # BAD 1: too few photos / no overlap (4 photos, 90° step)
    few_dir = ROOT / "data" / "ex_few"
    render_pano(few_dir, 4)
    few = sorted(few_dir.glob("shot_*.jpg"))
    cv2.imwrite(str(OUT / "bad_too_few.jpg"),
                contact_sheet(few, 4, "BAD: 4 photos, 90deg gaps, ~0% overlap -> stitch fails", (120, 120, 235)))
    _, dbg_few = stitch_panorama(few)

    # BAD 2: parallax — camera WALKS around (translation) instead of rotating
    walk_dir = ROOT / "data" / "ex_walk"
    render_room(walk_dir, 12)             # ring of *moving* cameras = parallax
    walk = sorted(walk_dir.glob("frame_*.jpg"))
    cv2.imwrite(str(OUT / "bad_parallax.jpg"),
                contact_sheet(walk, 4, "BAD: walking (parallax) instead of rotating in place", (120, 120, 235)))
    _, dbg_walk = stitch_panorama(walk)

    print("GOOD    :", dbg_good["status"], dbg_good.get("output_resolution"),
          f'{dbg_good["num_matches"]} matches')
    print("TOO_FEW :", dbg_few["status"], "-", dbg_few["reason"][:50])
    print("PARALLAX:", dbg_walk["status"], "-", dbg_walk["reason"][:50] or "(may stitch but ghost)")
    print("wrote example images ->", OUT.relative_to(ROOT.parent))


if __name__ == "__main__":
    main()
