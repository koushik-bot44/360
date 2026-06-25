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


def _fps_select(pairs, max_n=40):
    """Continuous 'paint the sphere' capture can hand us 100+ frames; cpfind on
    that many would blow Hugin's per-step timeout (and then we'd fall back to the
    soft orientation paint — the very thing we're replacing). Thin the set to an
    even spread over the sphere via farthest-point sampling on the shot directions,
    keeping ~max_n frames. Even spacing preserves overlap for the feature matcher
    while bounding the solve. (The orientation-paint fallback still uses them all.)"""
    if len(pairs) <= max_n:
        return list(pairs)
    vecs = []
    for _, (az, el) in pairs:
        a, e = az * (math.pi / 180), el * (math.pi / 180)
        ce = math.cos(e)
        vecs.append((ce * math.sin(a), math.sin(e), -ce * math.cos(a)))
    vecs = np.asarray(vecs)
    chosen = [0]
    mind = np.full(len(pairs), np.inf)
    for _ in range(max_n - 1):
        ang = np.arccos(np.clip(vecs @ vecs[chosen[-1]], -1.0, 1.0))
        mind = np.minimum(mind, ang)
        mind[chosen] = -1.0
        chosen.append(int(np.argmax(mind)))
    return [pairs[i] for i in sorted(chosen)]


def _seed_fov(sample_path):
    """Pick the seed horizontal FOV from the frame's aspect. Phone capture is
    PORTRAIT (tall), so the horizontal/short-side FOV is much narrower than the 65°
    landscape guess — seeding 65 over-scales every image and, when features are
    sparse (blank indoor walls), autooptimiser can't pull it back, so the panorama
    distorts. ~55° matches real portrait frames; landscape keeps 65. autooptimiser
    refines the shared value from this seed (and lands closer with a good start)."""
    im = cv2.imread(str(sample_path))
    if im is not None and im.shape[0] > im.shape[1]:
        return 55.0
    return FOV


def _seedgate_cps(pto_text, pairs, max_sep_deg=80.0):
    """Drop control points linking two frames whose SHOT directions are too far
    apart to actually share a view (> max_sep). With a ~55° lens two frames only
    overlap when their optical axes are within ~55°, so a control point between
    frames seeded 90°–180° apart is physically impossible — it's cpfind matching
    repeated decor or a blank wall to the OPPOSITE wall, which then drags that
    frame to the wrong side ('opposite-direction' misplacement). The seed angles
    are what make these bogus matches detectable. Returns (new_pto_text, dropped)."""
    dirs = []
    for _, (az, el) in pairs:
        a, e = az * (math.pi / 180), el * (math.pi / 180)
        ce = math.cos(e)
        dirs.append((ce * math.sin(a), math.sin(e), -ce * math.cos(a)))
    cosmax = math.cos(max_sep_deg * math.pi / 180)
    out, dropped = [], 0
    for ln in pto_text.splitlines():
        if ln.startswith("c "):
            mn = re.search(r"\bn(\d+)", ln)
            mN = re.search(r"\bN(\d+)", ln)
            if mn and mN:
                i, j = int(mn.group(1)), int(mN.group(1))
                if 0 <= i < len(dirs) and 0 <= j < len(dirs):
                    dot = sum(dirs[i][k] * dirs[j][k] for k in range(3))
                    if dot < cosmax:                 # separation > max_sep → impossible
                        dropped += 1
                        continue
        out.append(ln)
    return "\n".join(out) + "\n", dropped


def _clamp_to_seed(pto_text, pairs, max_dev=30.0):
    """After the solve, snap any frame that drifted FAR from its seed back into
    place. The seed pitch is gravity-accurate and the seed yaw is roughly right, so
    a frame can't truly be more than ~30° from (seed + a global offset). If the
    optimiser put one further than that, a bad/false match flipped it to the wrong
    side ('a right-facing photo ends up on the left') — we reset it to seed+offset.

    The global offset (median of optimised−seed) absorbs any whole-panorama rotation
    from horizon-levelling/the anchor, so we compare each frame to the CONSENSUS, not
    to an absolute angle. Real refinements (<30°) are kept. Returns (pto, n_reset)."""
    seeds = [(-az, el) for _, (az, el) in pairs]
    cdiff = lambda a, b: ((a - b + 180) % 360) - 180
    med = lambda xs: sorted(xs)[len(xs) // 2]

    def yp(line):                                   # read y/p from an i-line
        y = p = None
        for tk in line.split(" "):
            if len(tk) > 1 and tk[0] == "y" and tk[1] in "-.0123456789":
                try: y = float(tk[1:])
                except ValueError: pass
            elif len(tk) > 1 and tk[0] == "p" and tk[1] in "-.0123456789":
                try: p = float(tk[1:])
                except ValueError: pass
        return y, p

    opt, idx = [], 0
    for ln in pto_text.splitlines():
        if ln.startswith("i "):
            opt.append(yp(ln)); idx += 1
    n = min(len(opt), len(seeds))
    dy = [cdiff(opt[i][0], seeds[i][0]) for i in range(n) if opt[i][0] is not None]
    dp = [opt[i][1] - seeds[i][1] for i in range(n) if opt[i][1] is not None]
    if not dy:
        return pto_text, 0
    moff, poff = med(dy), (med(dp) if dp else 0.0)

    out, idx, reset = [], 0, 0
    for ln in pto_text.splitlines():
        if ln.startswith("i ") and idx < n:
            sy, sp = seeds[idx]
            ty, tp = sy + moff, sp + poff           # where consensus says it belongs
            oy, op_ = opt[idx]
            bad_y = oy is not None and abs(cdiff(oy, ty)) > max_dev
            bad_p = op_ is not None and abs(op_ - tp) > max_dev
            if bad_y or bad_p:
                toks = ln.split(" ")
                for k, tk in enumerate(toks):
                    if bad_y and len(tk) > 1 and tk[0] == "y" and tk[1] in "-.0123456789":
                        toks[k] = f"y{ty:g}"
                    elif bad_p and len(tk) > 1 and tk[0] == "p" and tk[1] in "-.0123456789":
                        toks[k] = f"p{tp:g}"
                ln = " ".join(toks); reset += 1
            idx += 1
        elif ln.startswith("i "):
            idx += 1
        out.append(ln)
    return "\n".join(out) + "\n", reset


def _smooth_poles(eq, nadir_deg=16.0, zenith_deg=15.0):
    """Equirectangular projection collapses the straight-down (nadir) and straight-up
    (zenith) singularities across the whole image width, so a single floor/ceiling
    shot smears into ugly radial streaks there. Collapse each pole cap smoothly toward
    its azimuthal average — fully at the exact pole, fading to none at the cap edge —
    turning the streaks into a clean disc while leaving real content (cap edge) intact.
    The nadir cap is larger (floors are plain + shot worst); the zenith cap smaller."""
    H, W = eq.shape[:2]
    out = eq.astype(np.float32)
    for deg, bottom in ((nadir_deg, True), (zenith_deg, False)):
        rows = max(1, int(round(H * deg / 180.0)))
        for i in range(rows):
            y = (H - 1 - i) if bottom else i
            w = (1.0 - i / rows) ** 2            # 1 at the pole row → ~0 at the cap edge
            if w <= 1e-3:
                continue
            mean = out[y].mean(axis=0)           # this row's azimuthal average colour
            out[y] = out[y] * (1.0 - w) + mean * w
    return out.astype(np.uint8)


def _stitch_hugin_seeded(pairs, fov=None):
    """Seeded Hugin stitch: write each frame's captured yaw/pitch as the INITIAL
    camera orientation into the .pto, then let cpfind + autooptimiser refine from
    there. This is the gold path for guided captures.

    Why seed: plain `pto_gen` Hugin has no idea where images go, so on low-overlap
    indoor captures (blank walls) the solve funnels/collapses — which is exactly
    why the orientation paint was bolted on as a short-circuit. Seeding the known
    angles puts every image in roughly the right place (no funnel), so the control
    points only have to *refine* — fixing the sensor-angle noise and the wrong FOV
    guess that wreck the raw-orientation placement. enblend then hides exposure
    seams (the orientation paint has no exposure compensation at all).

    `pairs` is a list of (image_path, (az_deg, el_deg)). Convention (determined
    empirically against ground truth): Hugin yaw = -az, pitch = +el, roll seeded 0
    then optimised. Returns (equirect BGR or None, reason); any failure → None so
    the caller falls back to the orientation paint.
    """
    if len(pairs) < 2:
        return None, "need at least 2 oriented images"
    work = Path(tempfile.mkdtemp(prefix="hseed_"))
    pto = work / "project.pto"

    env = dict(os.environ)
    if HUGIN_BIN:                                   # so hugin_executor finds nona/enblend
        env["PATH"] = HUGIN_BIN + os.pathsep + env.get("PATH", "")

    def run(cmd):
        cmd = [_hugin_tool(cmd[0]) or cmd[0], *cmd[1:]]
        subprocess.run(cmd, cwd=work, check=True, timeout=HUGIN_TIMEOUT, env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    try:
        paths = [str(Path(p).resolve()) for p, _ in pairs]
        if fov is None:
            fov = _seed_fov(paths[0])
        run(["pto_gen", "-o", str(pto), *paths])
        # seed the shared lens FOV + every image's orientation from capture angles
        sets = [f"v={fov}"]
        for i, (_, ori) in enumerate(pairs):
            az, el = ori
            sets += [f"y{i}={-az}", f"p{i}={el}", f"r{i}=0"]
        run(["pto_var", "--set=" + ",".join(sets), "-o", str(pto), str(pto)])
        # control points (multirow connects the rings densely; celeste drops sky/
        # uniform points). cpclean then prunes outliers — and because every image is
        # seeded near its true place, autooptimiser treats any match that would drag
        # an image far from its seed as the outlier, so cross-room false matches die.
        run(["cpfind", "--multirow", "--celeste", "-o", str(pto), str(pto)])
        run(["cpclean", "-o", str(pto), str(pto)])
        # seed-gate: remove cross-room false matches before they can flip a frame
        # to the wrong side (the 'opposite-direction' misplacement on blank walls).
        # Only rewrite when something is actually dropped — rewriting an unchanged
        # .pto can perturb the solve, and the common dense case drops nothing.
        txt = pto.read_text()
        gated, dropped = _seedgate_cps(txt, pairs)
        if dropped:
            pto.write_text(gated)
        ncp = sum(1 for ln in (gated if dropped else txt).splitlines() if ln.startswith("c "))
        # refine yaw/pitch/roll (anchor auto-handled) STARTING from the seeds
        # (-n = PTOptimizer mode, not a from-scratch -a). Only ALSO solve the shared
        # lens FOV when overlap is rich enough to constrain it: with sparse discrete
        # captures the FOV collapses (frames shrink → float as patches with black
        # gaps), so there we trust the seeded FOV instead. Dense sweeps keep solving
        # it (it refines the wrong 65° guess and sharpens). Threshold is per-image.
        # Refine yaw/pitch/roll from the seeds (-n = PTOptimizer mode). Also solve the
        # shared lens FOV ONLY when overlap is dense enough to constrain it: a dense
        # scene NEEDS it (fixing FOV there lets the solve collapse), while a sparse
        # real capture COLLAPSES if you try (too few points → FOV runs away), so there
        # we trust the seeded FOV. -m optimises exposure; -l levels the horizon.
        opt = "y,p,r"
        dense = ncp >= 25 * len(pairs)
        if dense:
            opt += ",v0"
        run(["pto_var", "--opt=" + opt, "-o", str(pto), str(pto)])
        run(["autooptimiser", "-n", "-m", "-l", "-o", str(pto), str(pto)])
        # Flip-corrector for the SPARSE path only (real low-texture rooms). There the
        # weak solve can flip a frame to the wrong side or warp it, and the seeds are
        # more trustworthy — snap frames that drifted >30° back to seed+offset. Dense
        # solves are reliable and left untouched (clamping them fights good refinements).
        reset = 0
        if not dense:
            clamped, reset = _clamp_to_seed(pto.read_text(), pairs, max_dev=30.0)
            if reset:
                pto.write_text(clamped)
        # projection 2 = equirectangular; full 360x180 sphere, AUTO canvas (then we
        # downscale to TARGET_WIDTH in _to_2to1). AUTO only ballooned to ~11000px
        # when the FOV collapsed; the conditional-FOV fix above prevents that, so
        # AUTO now stays sane — and it keeps the correct framing (forcing an exact
        # canvas shifted the output vertically and broke alignment).
        run(["pano_modify", "--projection=2", "--fov=360x180",
             "--canvas=AUTO", "-o", str(pto), str(pto)])

        # Blend (nona warp + enblend multi-band). enblend can bail on imperfect
        # real captures; retry with Hugin's internal blender (verdandi), tolerant.
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
        eq = _to_2to1(img)
        # funnel guard: a collapsed solve crams everything into a small blob. Judge
        # by AZIMUTH span, not raw area, so a legitimate horizontal-band capture
        # (full 360° wide but short — caps unshot) still passes; only a true
        # collapse (content in a narrow wedge) is rejected → fall back to the paint.
        filled_mask = cv2.cvtColor(eq, cv2.COLOR_BGR2GRAY) > 24
        az_cov = float(filled_mask.any(axis=0).mean())     # fraction of 360° covered
        filled = float(filled_mask.mean())                  # total area fraction
        if az_cov < 0.85 or filled < 0.22:
            return None, f"collapsed (az {az_cov:.0%}, fill {filled:.0%}, {ncp} cps)"
        # kill black gaps (directions that weren't captured) by inpainting them from
        # their surroundings — seamless, and avoids the alignment seams a paste would
        # cause. Only true-black (unshot) pixels are touched, not dark real content.
        holes = (cv2.cvtColor(eq, cv2.COLOR_BGR2GRAY) < 8).astype(np.uint8)
        gaps = float(holes.mean())
        if 0 < gaps < 0.35:
            holes = cv2.dilate(holes, np.ones((5, 5), np.uint8))
            eq = cv2.inpaint(eq, holes, 6, cv2.INPAINT_TELEA)
        # nadir/zenith patch: collapse the stretched pole smears into clean discs
        eq = _smooth_poles(eq)
        return eq, (f"ok ({ncp} cps, {dropped} cross-room dropped, {reset} reseated, "
                    f"az {az_cov:.0%}, fill {filled:.0%}, {gaps:.0%} gaps filled)")
    except subprocess.TimeoutExpired:
        return None, "hugin timed out"
    except subprocess.CalledProcessError as e:
        msg = (e.stderr or b"").decode("utf-8", "ignore").strip().splitlines()
        return None, f"hugin step failed: {msg[-1] if msg else e}"
    except Exception as e:                              # never let Hugin crash the request
        return None, f"hugin seeded error: {e}"
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


def _stitch_oriented(image_paths, orientations, width=TARGET_WIDTH):
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

    # Track the TOP-2 photos per pixel by "centeredness", then blend them only in a
    # thin band right at the seam (where their centeredness is ~equal). Photo
    # interiors stay 100% one source (sharp, no ghosting); only the hard seam line
    # softens into a smooth transition. No global blur, so no haze either.
    best1 = np.full((H, W), -1.0, np.float32); col1 = np.full((H, W, 3), 16.0, np.float32)
    best2 = np.full((H, W), -1.0, np.float32); col2 = np.full((H, W, 3), 16.0, np.float32)
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
        warped = cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT).astype(np.float32)
        cen = np.where(inside, np.clip(1 - np.maximum(np.abs(nx), np.abs(ny)), 0, 1), -1.0).astype(np.float32)
        a = cen > best1                                 # new winner → demote old to runner-up
        best2 = np.where(a, best1, best2); col2 = np.where(a[..., None], col1, col2)
        best1 = np.where(a, cen, best1); col1 = np.where(a[..., None], warped, col1)
        b = (~a) & (cen > best2)                         # new runner-up
        best2 = np.where(b, cen, best2); col2 = np.where(b[..., None], warped, col2)
        placed += 1

    if placed < 2:
        return None, placed
    band = 0.05                                          # seam-transition width (centeredness units)
    t = np.clip((best1 - best2) / band, 0.0, 1.0)        # 0 at the seam, 1 deep in a photo's territory
    mix = (0.5 + 0.5 * t)[..., None]                     # owner-1 fraction (50/50 exactly at the seam)
    out = np.where((best2 >= 0)[..., None], col1 * mix + col2 * (1.0 - mix), col1)
    out = np.where((best1 >= 0)[..., None], out, 16.0)
    return out.astype(np.uint8), placed


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

    # Guided capture: the shots carry the yaw/pitch they were taken at. Use those
    # angles as a SEED for a real feature-based solve (sharp + exposure-blended),
    # and only fall back to painting by raw angles if that can't lock.
    if orientations and sum(o is not None for o in orientations) >= max(2, int(len(image_paths) * 0.6)):
        pairs = [(p, o) for p, o in zip(image_paths, orientations) if o is not None]

        # 1) SEEDED HUGIN — sensor angles place every image (no funnel), control
        #    points refine them sharp and enblend hides exposure seams. The angle
        #    noise + FOV guess that wreck raw placement get corrected here. Best
        #    quality when Hugin is installed; falls through if it can't lock.
        if _hugin_available():
            hpano, hreason = _stitch_hugin_seeded(_fps_select(pairs))
            if hpano is not None:
                debug.update(engine="hugin-seeded", status="ok", reason="ok",
                             num_images_used=len(pairs), vertical_fov_deg=180.0,
                             output_resolution=[int(hpano.shape[1]), int(hpano.shape[0])],
                             hugin_seeded=hreason)
                return hpano, debug
            debug["hugin_seeded_reason"] = hreason

        # 2) ORIENTATION PAINT — place each photo where it was shot. No feature
        #    alignment (softer, can ghost), but it ALWAYS fills the sphere — never
        #    funnels or blacks out the low-texture floor. The safety net.
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
