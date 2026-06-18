"""Synthetic camera poses for when COLMAP is not installed.

Lets the whole POC run end-to-end (photos in → tour.json out → viewer) without
the heavy CV dependency. Arranges the photos as if the user stood in the middle
of a room and rotated, taking one shot per direction (a ring of cameras facing
outward). This is NOT reconstruction — it's a stand-in so the pipeline and the
viewer integration are demonstrable. Real geometry comes from COLMAP.
"""
import math


def generate(image_names):
    n = max(1, len(image_names))
    nodes = []
    for i, name in enumerate(image_names):
        ang = (i / n) * 2 * math.pi
        # small ring of camera centers, each looking outward
        cx, cz = 0.25 * math.cos(ang), 0.25 * math.sin(ang)
        fwd = [math.cos(ang), 0.0, math.sin(ang)]
        nodes.append({"name": name, "position": [cx, 0.0, cz], "forward": fwd})
    return nodes
