"""Auto-link two panoramas: estimate the bearing from each toward the other.

Two equirectangular panoramas shot at different spots in the same space see the
same surfaces. We match features, convert each matched pixel to a unit BEARING on
the sphere (same convention as the viewer), and estimate the relative pose via the
essential matrix on bearings (8-point + RANSAC). The translation direction (the
epipole) is the heading from one panorama to the other — i.e. where to place the
"go to that room" hotspot.

Bearing convention (matches src/builder/PanoViewer.js):
  column j -> azimuth a = 2*pi*(j+0.5)/W   (a = atan2(z, x))
  row i    -> polar  f = pi*(i+0.5)/H       (from +y)
  dir = (cos a * sin f, cos f, sin a * sin f)
"""
import cv2
import numpy as np

MAX_W = 1600
RANSAC_ITERS = 600
INLIER_THRESH = 0.01      # normalized epipolar residual (≈ angular error)
MIN_INLIERS = 25          # below this, treat the pair as "not connected"


def _bearings(pts, W, H):
    a = 2 * np.pi * (pts[:, 0] + 0.5) / W
    f = np.pi * (pts[:, 1] + 0.5) / H
    s = np.sin(f)
    return np.stack([np.cos(a) * s, np.cos(f), np.sin(a) * s], axis=-1)


def _match(imgA, imgB):
    def prep(im):
        h, w = im.shape[:2]
        sc = min(1.0, MAX_W / w)
        if sc < 1.0:
            im = cv2.resize(im, (int(w * sc), int(h * sc)), interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), im.shape[1], im.shape[0]

    gA, WA, HA = prep(imgA)
    gB, WB, HB = prep(imgB)
    sift = cv2.SIFT_create(4000)
    kA, dA = sift.detectAndCompute(gA, None)
    kB, dB = sift.detectAndCompute(gB, None)
    if dA is None or dB is None or len(kA) < 8 or len(kB) < 8:
        return None
    bf = cv2.BFMatcher(cv2.NORM_L2)
    raw = bf.knnMatch(dA, dB, k=2)
    good = [m for m, n in raw if m.distance < 0.75 * n.distance]
    if len(good) < 8:
        return None
    ptsA = np.float32([kA[m.queryIdx].pt for m in good])
    ptsB = np.float32([kB[m.trainIdx].pt for m in good])
    return _bearings(ptsA, WA, HA), _bearings(ptsB, WB, HB)


def _essential_8pt(a, b):
    """Solve b_i^T E a_i = 0 (least squares), enforce essential rank-2 (1,1,0)."""
    M = np.einsum('ni,nj->nij', b, a).reshape(len(a), 9)
    _, _, Vt = np.linalg.svd(M)
    E = Vt[-1].reshape(3, 3)
    U, _, Vt2 = np.linalg.svd(E)
    if np.linalg.det(U) < 0: U = -U
    if np.linalg.det(Vt2) < 0: Vt2 = -Vt2
    E = U @ np.diag([1, 1, 0]) @ Vt2
    return E


def _residual(E, a, b):
    Ea = a @ E.T            # (N,3)  == (E a)
    Etb = b @ E             # (N,3)  == (E^T b)
    num = np.abs(np.einsum('ni,ni->n', b, Ea))
    den = np.sqrt((Ea ** 2).sum(1) + (Etb ** 2).sum(1)) + 1e-12
    return num / den


def _ransac(a, b):
    n = len(a)
    rng = np.random.default_rng(12345)        # fixed seed → reproducible links
    best_inl, best_E = None, None
    for _ in range(RANSAC_ITERS):
        sel = rng.choice(n, 8, replace=False)
        try:
            E = _essential_8pt(a[sel], b[sel])
        except np.linalg.LinAlgError:
            continue
        inl = _residual(E, a, b) < INLIER_THRESH
        if best_inl is None or inl.sum() > best_inl.sum():
            best_inl, best_E = inl, E
    if best_E is None or best_inl.sum() < 8:
        return None
    # refit on all inliers
    E = _essential_8pt(a[best_inl], b[best_inl])
    inl = _residual(E, a, b) < INLIER_THRESH
    return E, inl


def _triangulate_depths(a, b, R, t):
    """Closest-point depths for rays a (cam1) and b (cam2); cam2 center C=-R^T t,
    world ray dir r2 = R^T b. Returns (alpha, beta) depths."""
    C = -R.T @ t
    r2 = b @ R                       # (N,3) world directions of b
    # solve min |alpha*a - (C + beta*r2)| per correspondence
    aa = np.ones(len(a))             # a·a = 1 (unit)
    rr = np.ones(len(a))             # r2·r2 = 1
    ar = np.einsum('ni,ni->n', a, r2)
    Ca = a @ C
    Cr = r2 @ C
    denom = (aa * rr - ar * ar) + 1e-12
    alpha = (rr * Ca - ar * Cr) / denom
    beta = (ar * Ca - aa * Cr) / denom
    return alpha, beta


def _decompose(E, a, b, inl):
    U, _, Vt = np.linalg.svd(E)
    if np.linalg.det(U) < 0: U = -U
    if np.linalg.det(Vt) < 0: Vt = -Vt
    W = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1.0]])
    cands = [(U @ W @ Vt, U[:, 2]), (U @ W @ Vt, -U[:, 2]),
             (U @ W.T @ Vt, U[:, 2]), (U @ W.T @ Vt, -U[:, 2])]
    ai, bi = a[inl], b[inl]
    best, best_score = None, -1
    for R, t in cands:
        al, be = _triangulate_depths(ai, bi, R, t)
        score = int(((al > 0) & (be > 0)).sum())
        if score > best_score:
            best_score, best = score, (R, t)
    return best


def link_panos(imgA, imgB):
    """Return bearings + stats for connecting two panoramas.

    dirA = unit heading in A's frame toward B  (hotspot dir in A)
    dirB = unit heading in B's frame toward A  (hotspot dir in B)
    """
    out = {"linked": False, "num_matches": 0, "inliers": 0, "confidence": 0.0, "reason": ""}
    m = _match(imgA, imgB)
    if m is None:
        out["reason"] = "too few feature matches between the panoramas"
        return out
    a, b = m
    out["num_matches"] = int(len(a))

    res = _ransac(a, b)
    if res is None:
        out["reason"] = "could not estimate a consistent relative pose"
        return out
    E, inl = res
    out["inliers"] = int(inl.sum())
    out["confidence"] = round(float(inl.sum()) / max(1, len(a)), 3)
    if inl.sum() < MIN_INLIERS:
        out["reason"] = f"weak overlap ({int(inl.sum())} inliers) — likely not connected"
        return out

    R, t = _decompose(E, a, b, inl)
    dirA = -R.T @ t; dirA = dirA / (np.linalg.norm(dirA) or 1.0)   # A -> B in A frame
    dirB = t / (np.linalg.norm(t) or 1.0)                          # B -> A in B frame
    out.update(linked=True, reason="ok",
               dirA={"x": float(dirA[0]), "y": float(dirA[1]), "z": float(dirA[2])},
               dirB={"x": float(dirB[0]), "y": float(dirB[1]), "z": float(dirB[2])})
    return out
