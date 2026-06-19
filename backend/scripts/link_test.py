"""Validate room auto-linking against ground truth.

Renders two panoramas at known positions in the synthetic room, runs link_panos,
and checks the recovered bearing (A→B and B→A) against the true direction.

Run from backend/:  python scripts/link_test.py
"""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts.make_pano_at import render_pano_at  # noqa: E402
from app.pipeline.link import link_panos          # noqa: E402


def angle(u, v):
    u = np.array(u, float); v = np.array(v, float)
    u /= np.linalg.norm(u); v /= np.linalg.norm(v)
    return float(np.degrees(np.arccos(np.clip(u @ v, -1, 1))))


def run_case(name, posA, posB):
    imgA = render_pano_at(posA)
    imgB = render_pano_at(posB)
    r = link_panos(imgA, imgB)
    trueA = np.array(posB, float) - np.array(posA, float)   # A -> B
    trueB = -trueA                                          # B -> A
    print(f"\n[{name}]  A={posA}  B={posB}")
    print(f"  matches={r['num_matches']} inliers={r['inliers']} conf={r['confidence']} linked={r['linked']}")
    if not r["linked"]:
        print("  FAIL:", r["reason"]); return False
    dA = [r["dirA"]["x"], r["dirA"]["y"], r["dirA"]["z"]]
    dB = [r["dirB"]["x"], r["dirB"]["y"], r["dirB"]["z"]]
    eA, eB = angle(dA, trueA), angle(dB, trueB)
    print(f"  dirA={np.round(dA,2)}  (truth {np.round(trueA/np.linalg.norm(trueA),2)})  err {eA:.1f}°")
    print(f"  dirB={np.round(dB,2)}  (truth {np.round(trueB/np.linalg.norm(trueB),2)})  err {eB:.1f}°")
    ok = eA < 20 and eB < 20
    print("  ", "PASS" if ok else "FAIL (bearing off)")
    return ok


def main():
    cases = [
        ("along +x", [-1.5, 0, 0], [1.5, 0, 0]),
        ("along +z", [0, 0, -1.5], [0, 0, 1.5]),
        ("diagonal", [-1.2, 0, -1.2], [1.2, 0, 1.2]),
    ]
    results = [run_case(*c) for c in cases]
    print("\n==>", "ALL PASS" if all(results) else "SOME FAILED")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
