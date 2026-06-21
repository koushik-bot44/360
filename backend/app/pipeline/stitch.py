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
import glob
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

# Cap the working size so stitching is fast and bundle adjustment is stable;
# phone photos are far larger than we need for a web panorama.
MAX_DIM = 1600
TARGET_WIDTH = 4096          # final equirectangular width (height = width / 2)
FOV = 65.0                   # assumed phone horizontal FOV (deg) for orientation-based stitch
HUGIN_TIMEOUT = 240          # seconds per Hugin CLI step before giving up → fallback

# Where to find Hugin's CLI tools. Prefer $HUGIN_BIN; else a local app-bundle
# install (e.g. the Hugin.app copied into the home dir on macOS). When the tools
# live in an app bundle their dylibs sit in ../Libraries via @executable_path,
# so calling them by full path Just Works.
_DEFAULT_HUGIN = os.path.expanduser("~/hugin/Hugin.app/Contents/MacOS")
HUGIN_BIN = os.environ.get("HUGIN_BIN") or (_DEFAULT_HUGIN if os.path.isdir(_DEFAULT_HUGIN) else "")
HUGIN_TOOLS = ("pto_gen", "cpfind", "cpclean", "autooptimiser",
               "pano_modify", "hugin_executor", "nona", "enblend")

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


def _hugin_tool(name):
    """Resolve a Hugin CLI tool: prefer $HUGIN_BIN / the detected app bundle,
    then PATH. Returns an executable path or None."""
    if HUGIN_BIN:
        p = os.path.join(HUGIN_BIN, name)
        if os.access(p, os.X_OK):
            return p
    return shutil.which(name)


def _hugin_available():
    """Treat Hugin as available only if the whole chain we use resolves (else
    fall back to OpenCV)."""
    return all(_hugin_tool(t) for t in HUGIN_TOOLS)


def _to_2to1(img):
    """Normalise a panorama to a 2:1 equirectangular canvas (pad short poles,
    centre-crop if over-tall, cap width to TARGET_WIDTH)."""
    if img is None:
        return None
    if img.ndim == 3 and img.shape[2] == 4:        # drop alpha from Hugin TIFFs
        img = img[:, :, :3]
    h, w = img.shape[:2]
    target_h = w // 2
    if h > target_h:
        y0 = (h - target_h) // 2
        canvas = img[y0:y0 + target_h]
    elif h < target_h:
        canvas = np.full((target_h, w, 3), 16, np.uint8)
        y0 = (target_h - h) // 2
        canvas[y0:y0 + h] = img
    else:
        canvas = img
    if canvas.shape[1] > TARGET_WIDTH:
        canvas = cv2.resize(canvas, (TARGET_WIDTH, TARGET_WIDTH // 2), interpolation=cv2.INTER_AREA)
    return canvas


def _stitch_hugin(image_paths):
    """Stitch with Hugin's CLI (cpfind/autooptimiser/nona/enblend) into a full
    360x180 equirectangular. Much stronger at poles/seams than OpenCV's Stitcher.
    Returns (equirect BGR or None, reason). Any failure → None so we fall back."""
    work = Path(tempfile.mkdtemp(prefix="hugin_"))
    pto = work / "project.pto"

    env = dict(os.environ)
    if HUGIN_BIN:                                   # so hugin_executor finds nona/enblend
        env["PATH"] = HUGIN_BIN + os.pathsep + env.get("PATH", "")

    def run(cmd):
        cmd = [_hugin_tool(cmd[0]) or cmd[0], *cmd[1:]]
        subprocess.run(cmd, cwd=work, check=True, timeout=HUGIN_TIMEOUT, env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    try:
        # absolute paths — pto_gen runs with cwd=work, so relative paths wouldn't resolve
        run(["pto_gen", "-o", str(pto), *[str(Path(p).resolve()) for p in image_paths]])
        # control points (multirow handles ring captures; celeste drops sky points)
        run(["cpfind", "--multirow", "--celeste", "-o", str(pto), str(pto)])
        run(["cpclean", "-o", str(pto), str(pto)])
        # optimise positions + photometric, then force a full-sphere equirect canvas
        run(["autooptimiser", "-a", "-m", "-l", "-s", "-o", str(pto), str(pto)])
        # projection 2 = equirectangular; full 360x180 sphere; no autocrop so the
        # poles aren't trimmed away (omitting --crop leaves the canvas uncropped).
        run(["pano_modify", "--projection=2", "--fov=360x180",
             "--canvas=AUTO", "-o", str(pto), str(pto)])

        # Blend. enblend is best but can bail ("invalid output image") on real
        # captures with imperfect/low-overlap layers. If it does, retry with
        # Hugin's internal blender (verdandi), which is far more tolerant.
        def stitched():
            return sorted(glob.glob(str(work / "pano*.tif")) + glob.glob(str(work / "pano*.jpg")))
        try:
            run(["hugin_executor", "--stitching", "--prefix=pano", str(pto)])
        except subprocess.CalledProcessError:
            for f in stitched():
                os.remove(f)
            with open(pto, "a") as fh:                  # switch blender, then retry
                fh.write("\n#hugin_blender internal\n")
            run(["hugin_executor", "--stitching", "--prefix=pano", str(pto)])

        outs = stitched()
        if not outs:
            return None, "hugin produced no output"
        img = cv2.imread(outs[0], cv2.IMREAD_COLOR)
        if img is None:
            return None, "hugin output unreadable"
        return _to_2to1(img), "ok"
    except subprocess.TimeoutExpired:
        return None, "hugin timed out"
    except subprocess.CalledProcessError as e:
        msg = (e.stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        return None, f"hugin step failed: {msg[-1] if msg else e}"
    except Exception as e:                              # never let Hugin crash the request
        return None, f"hugin error: {e}"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _stitch_openstitching(image_paths):
    """Stitch with the OpenStitching package — OpenCV's *detailed* pipeline (SIFT,
    bundle adjustment, spherical warp, gain compensation, multi-band blend) with
    much better defaults than the raw cv2.Stitcher. Returns (spherical BGR strip
    or None, reason). Used as the fallback when Hugin is unavailable or fails."""
    try:
        from stitching import Stitcher
    except ImportError:
        return None, "stitching package not installed"
    try:
        st = Stitcher(detector="sift", confidence_threshold=0.5,
                      warper_type="spherical", crop=False)
        pano = st.stitch([str(p) for p in image_paths])
        return pano, "ok"
    except Exception as e:                       # StitchingError etc. → fall through
        return None, f"{type(e).__name__}: {e}".strip()[:200]


def parse_orientation(name):
    """Guided-capture frames are named y{p|m}NNN_p{p|m}NNN.jpg, encoding the
    yaw/pitch the shot was taken at. Returns (az_deg, el_deg) or None."""
    m = re.match(r"y([pm])(\d+)_p([pm])(\d+)", Path(name).stem)
    if not m:
        return None
    yaw = int(m.group(2)) * (-1 if m.group(1) == "m" else 1)
    pit = int(m.group(4)) * (-1 if m.group(3) == "m" else 1)
    return (float(yaw), float(pit))


def _stitch_oriented(image_paths, orientations, width=TARGET_WIDTH, feather_pow=16):
    """Orientation-based stitch: project each photo onto the equirectangular
    sphere at the angle it was SHOT (yaw/pitch from capture) and feather-blend.
    Positions are known, not solved — so it never funnels and always fills the
    sphere, at the cost of some softness where overlaps don't perfectly align.
    Returns (equirect BGR or None, num_placed)."""
    W = width
    H = width // 2
    lon = (np.arange(W) + 0.5) / W * 2 * math.pi - math.pi
    lat = math.pi / 2 - (np.arange(H) + 0.5) / H * math.pi
    lon, lat = np.meshgrid(lon, lat)
    cl = np.cos(lat)
    dirs = np.stack([cl * np.sin(lon), np.sin(lat), -cl * np.cos(lon)], axis=-1)

    acc = np.zeros((H, W, 3), np.float32)
    wsum = np.zeros((H, W), np.float32)
    placed = 0
    for path, ori in zip(image_paths, orientations):
        if ori is None:
            continue
        img = cv2.imread(str(path))
        if img is None:
            continue
        az, el = ori[0] * (math.pi / 180), ori[1] * (math.pi / 180)
        ce = math.cos(el)
        f = np.array([ce * math.sin(az), math.sin(el), -ce * math.cos(az)])
        up = np.array([0.0, 1.0, 0.0])
        r = np.cross(f, up)
        nr = np.linalg.norm(r)
        if nr < 1e-6:                                   # looking straight up/down
            up = np.array([0.0, 0.0, 1.0])
            r = np.cross(f, up)
            nr = np.linalg.norm(r)
        r /= nr
        uc = np.cross(r, f)
        R = np.stack([r, uc, -f], axis=1)               # world-from-camera
        ph, pw = img.shape[:2]
        thx = math.tan(FOV * (math.pi / 180) / 2)
        thy = thx * ph / pw
        dcam = dirs @ R                                  # = R^T · dir = camera-space dir
        dz = dcam[..., 2]
        front = dz < -1e-6
        safe = np.where(front, -dz, 1.0)
        nx = (dcam[..., 0] / safe) / thx
        ny = (dcam[..., 1] / safe) / thy
        inside = front & (np.abs(nx) <= 1) & (np.abs(ny) <= 1)
        mx = ((nx + 1) / 2 * (pw - 1)).astype(np.float32)
        my = ((1 - (ny + 1) / 2) * (ph - 1)).astype(np.float32)
        warped = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        feather = np.clip(1 - np.maximum(np.abs(nx), np.abs(ny)), 0, 1) ** feather_pow
        w = (feather * inside).astype(np.float32)
        acc += warped.astype(np.float32) * w[..., None]
        wsum += w
        placed += 1

    if placed < 2:
        return None, placed
    out = np.where(wsum[..., None] > 1e-6, acc / np.maximum(wsum[..., None], 1e-6), 16).astype(np.uint8)
    return out, placed


def stitch_panorama(image_paths, orientations=None):
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

    # Orientation-based stitch FIRST when the shots carry their capture angles
    # (guided capture): place each photo where it was shot → always a complete
    # sphere, no funnel, no black. Feature stitchers below need overlap and can
    # leave the low-texture floor black; this can't, because positions are known.
    if orientations and sum(o is not None for o in orientations) >= max(2, int(len(image_paths) * 0.6)):
        oimg, placed = _stitch_oriented(image_paths, orientations)
        if oimg is not None:
            debug.update(engine="oriented", status="ok", reason="ok",
                         num_images_used=placed, vertical_fov_deg=180.0,
                         output_resolution=[int(oimg.shape[1]), int(oimg.shape[0])])
            return oimg, debug
        debug["oriented_reason"] = f"only {placed} placeable"

    # Prefer Hugin when installed — it's much stronger on full-sphere poles/seams.
    # Falls back to OpenCV automatically if Hugin isn't on PATH or fails.
    if _hugin_available():
        hpano, hreason = _stitch_hugin(image_paths)
        if hpano is not None:
            debug.update(engine="hugin", status="ok", reason="ok",
                         output_resolution=[int(hpano.shape[1]), int(hpano.shape[0])],
                         vertical_fov_deg=180.0)
            return hpano, debug
        debug["hugin_reason"] = hreason          # record why we fell back

    # Second choice: OpenStitching (OpenCV's detailed pipeline, far better tuned
    # than the raw cv2.Stitcher below). Its output is a spherical-warped strip,
    # same as cv2's PANORAMA mode, so the same equirect placement applies.
    ospano, osreason = _stitch_openstitching(image_paths)
    if ospano is not None:
        equirect, vfov, _ = _spherical_to_equirect(ospano)
        debug.update(engine="openstitching", status="ok", reason="ok",
                     raw_panorama_resolution=[int(ospano.shape[1]), int(ospano.shape[0])],
                     output_resolution=[int(equirect.shape[1]), int(equirect.shape[0])],
                     vertical_fov_deg=round(vfov, 1))
        return equirect, debug
    debug["openstitching_reason"] = osreason

    # Last resort: raw cv2.Stitcher. Try progressively more forgiving confidence
    # handheld captures have uneven overlap, and the default (1.0) rejects
    # borderline pairs and fails with NEED_MORE_IMGS even when a good panorama is
    # possible. A higher registration resolution gives the feature matcher more
    # pixels → better alignment on weak overlap (exposure is already block-gain
    # and seams graph-cut by default in PANORAMA mode, so re-setting those — as
    # some snippets suggest — is a no-op, and the methods don't even exist here).
    status, pano = cv2.Stitcher_ERR_NEED_MORE_IMGS, None
    for conf in (1.0, 0.7, 0.5):
        stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
        stitcher.setPanoConfidenceThresh(conf)
        stitcher.setRegistrationResol(0.8)       # default 0.6 → better control points
        status, pano = stitcher.stitch(imgs)
        if status == cv2.Stitcher_OK and pano is not None:
            debug["pano_confidence_thresh"] = conf
            break
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
