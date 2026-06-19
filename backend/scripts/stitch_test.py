"""Render a rotation capture, stitch it, and report debug info + save the result.

Run from backend/:  python scripts/stitch_test.py [num_photos]
"""
import json
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.pipeline.stitch import stitch_panorama  # noqa: E402
from scripts.make_synthetic_pano import render  # noqa: E402


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 14
    cap_dir = ROOT / "data" / "pano_capture"
    render(cap_dir, n)
    paths = sorted(cap_dir.glob("shot_*.jpg"))

    equirect, debug = stitch_panorama(paths)
    print(json.dumps(debug, indent=2))

    if equirect is not None:
        out = ROOT / "samples" / "sample_panorama.jpg"
        out.parent.mkdir(exist_ok=True)
        cv2.imwrite(str(out), equirect, [cv2.IMWRITE_JPEG_QUALITY, 90])
        print("wrote", out.relative_to(ROOT))
        print("PASS")
    else:
        print("FAIL —", debug["reason"])
        sys.exit(1)


if __name__ == "__main__":
    main()
