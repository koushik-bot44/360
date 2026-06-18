"""Turn camera poses into a navigation graph: nodes + auto-generated hotspots.

This is the core "automatic" step — no manual hotspot placement. Each camera
pose becomes a navigation node; each node is linked to its nearest neighbours,
and every hotspot's direction is computed by projecting the neighbour's real 3D
position into this node's camera frame. So the dot literally points at where the
next viewpoint is.
"""
import numpy as np

K_NEAREST = 2          # links per node (a small ring/graph)
MAX_LINK_DIST = 5.0    # ignore neighbours farther than this (world units)


def _basis(forward):
    f = np.array(forward, dtype=float)
    f = f / (np.linalg.norm(f) or 1.0)
    world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(world_up, f)
    if np.linalg.norm(right) < 1e-6:
        right = np.array([1.0, 0.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(f, right)
    return right, up, f


def _hotspot_dir(node_a, node_b):
    """Direction to B in A's local frame, mapped to the viewer's convention
    (viewer initial camera looks +x, up +y)."""
    right, up, fwd = _basis(node_a["forward"])
    d = np.array(node_b["position"]) - np.array(node_a["position"])
    n = np.linalg.norm(d)
    if n < 1e-9:
        return {"x": 1.0, "y": 0.0, "z": 0.0}
    d /= n
    x_r, y_u, z_f = float(d @ right), float(d @ up), float(d @ fwd)
    # forward -> +x, up -> +y, right -> +z
    v = np.array([z_f, y_u, x_r])
    v = v / (np.linalg.norm(v) or 1.0)
    return {"x": float(v[0]), "y": float(v[1]), "z": float(v[2])}


def build(nodes):
    """nodes: [{name, position, forward}] -> list of scene dicts with hotspots."""
    pts = np.array([n["position"] for n in nodes]) if nodes else np.zeros((0, 3))
    scenes = []
    for i, node in enumerate(nodes):
        # nearest neighbours by 3D distance
        order = []
        if len(nodes) > 1:
            dists = np.linalg.norm(pts - pts[i], axis=1)
            dists[i] = np.inf
            order = [j for j in np.argsort(dists)
                     if dists[j] <= MAX_LINK_DIST][:K_NEAREST]
        hotspots = []
        for j in order:
            hotspots.append({
                "id": f"edge_{i}_{j}",
                "dir": _hotspot_dir(node, nodes[j]),
                "target": f"node_{j}",
                "label": f"Go to {nodes[j]['name']}",
            })
        scenes.append({
            "id": f"node_{i}",
            "name": f"Viewpoint {i + 1}",
            "_image_name": node["name"],     # filled with a URL in export.py
            "floor": "Ground Floor",
            "position": [float(x) for x in node["position"]],
            "hotspots": hotspots,
        })
    return scenes
