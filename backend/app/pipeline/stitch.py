"""Stitch overlapping phone photos into a true equirectangular panorama.

Uses OpenCV's high-level Stitcher in PANORAMA mode (spherical warp). The stitched
result is a spherical strip (linear in azimuth/elevation); we place it into a 2:1
equirectangular canvas so the sphere viewer can load it directly. A single
horizontal ring fills the middle band (neutral caps top/bottom); a full-sphere
multi-ring capture (middle + upper/lower rings + poles) fills the whole canvas —
the same code path handles both (caps shrink to nothing as vertical coverage grows).

Returns the panorama plus debugging info: images used, matched features, output
resolution, and a clear success/failure reason.
"""
from pathlib import Path

import cv2
import numpy as np

# Cap the working size so stitching is fast and bundle adjustment is stable;
# phone photos are far larger than we need for a web panorama.
MAX_DIM = 1600
TARGET_WIDTH = 4096          # final equirectangular width (height = width / 2)

_STATUS_REASON = {
    cv2.Stitcher_OK: "ok",
    cv2.Stitcher_ERR_NEED_MORE_IMGS:
        "need more images — too few overlapping photos were matched. "
        "Capture more shots with greater overlap (see CAPTURE_GUIDE.md).",
    cv2.Stitcher_ERR_HOMOGRAPHY_EST_FAIL:
        "could not align images — not enough overlap or too much parallax. "
        "Rotate in place (don't walk) and keep ~40%+ overlap between shots.",
    cv2.Stitcher_ERR_CAMERA_PARAMS_ADJUST_FAIL:
        "camera parameter estimation failed — inconsistent overlaps or moving "
        "subjects. Re-capture a steady, even sweep.",
}


def _load(image_paths):
    imgs, names = [], []
    for p in image_paths:
        img = cv2.imread(str(p))
        if img is None:
            continue
        h, w = img.shape[:2]
        s = MAX_DIM / max(h, w)
        if s < 1.0:
            img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        imgs.append(img)
        names.append(Path(p).name)
    return imgs, names


def _feature_diagnostics(imgs):
    """Cheap ORB feature + consecutive-overlap report (independent of the stitch),
    so we can show match counts and warn about weak overlap."""
    orb = cv2.ORB_create(2000)
    kps, descs = [], []
    for img in imgs:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        k, d = orb.detectAndCompute(gray, None)
        kps.append(k or [])
        descs.append(d)
    total_features = int(sum(len(k) for k in kps))

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    pair_matches, total_matches = [], 0
    for i in range(len(imgs) - 1):
        if descs[i] is None or descs[i + 1] is None:
            pair_matches.append(0)
            continue
        m = bf.match(descs[i], descs[i + 1])
        # "good" matches by Hamming distance
        good = [x for x in m if x.distance < 48]
        pair_matches.append(len(good))
        total_matches += len(good)
    return total_features, total_matches, pair_matches


def _spherical_to_equirect(pano, target_width=TARGET_WIDTH):
    """Place the spherical-warped strip into a 2:1 equirectangular canvas.

    The PANORAMA-mode spherical warp is linear in angle with the SAME scale on
    both axes, so a full 360° horizontal sweep makes the strip width == 360°.
    We treat width as 360°, build a width × width/2 canvas, and paste the strip
    vertically centered (its height = its captured vertical FOV), leaving neutral
    caps top/bottom. Assumes a full-circle horizontal capture (see CAPTURE_GUIDE).
    """
    ph, pw = pano.shape[:2]
    eq_w = target_width
    eq_h = target_width // 2
    scale = eq_w / pw
    strip = cv2.resize(pano, (eq_w, max(1, int(round(ph * scale)))),
                       interpolation=cv2.INTER_AREA)
    sh = strip.shape[0]
    canvas = np.full((eq_h, eq_w, 3), 16, np.uint8)   # near-black neutral caps
    if sh >= eq_h:
        y0 = (sh - eq_h) // 2
        canvas[:] = strip[y0:y0 + eq_h]
        covered = (0.0, 1.0)
    else:
        y0 = (eq_h - sh) // 2
        canvas[y0:y0 + sh] = strip
        covered = (y0 / eq_h, (y0 + sh) / eq_h)
    vfov = 180.0 * min(1.0, sh / eq_h)
    return canvas, vfov, covered


def stitch_panorama(image_paths):
    """Stitch photos -> (equirect BGR image or None, debug dict)."""
    imgs, names = _load(image_paths)
    debug = {
        "num_images_input": len(image_paths),
        "num_images_used": len(imgs),
        "num_features": 0,
        "num_matches": 0,
        "pair_matches": [],
        "status": "failed",
        "reason": "",
        "output_resolution": None,
        "vertical_fov_deg": None,
        "engine": "opencv-stitcher-panorama",
    }
    if len(imgs) < 2:
        debug["reason"] = "need at least 2 images"
        return None, debug

    feats, matches, pair_matches = _feature_diagnostics(imgs)
    debug.update(num_features=feats, num_matches=matches, pair_matches=pair_matches)

    stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
    status, pano = stitcher.stitch(imgs)
    debug["raw_status_code"] = int(status)
    if status != cv2.Stitcher_OK or pano is None:
        debug["reason"] = _STATUS_REASON.get(status, f"stitch failed (code {status})")
        return None, debug

    equirect, vfov, _ = _spherical_to_equirect(pano)
    debug.update(
        status="ok",
        reason="ok",
        raw_panorama_resolution=[int(pano.shape[1]), int(pano.shape[0])],
        output_resolution=[int(equirect.shape[1]), int(equirect.shape[0])],
        vertical_fov_deg=round(vfov, 1),
    )
    return equirect, debug
