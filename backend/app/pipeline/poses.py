"""Parse camera poses from a COLMAP sparse model (images.txt).

COLMAP stores world-to-camera pose as a quaternion (qw,qx,qy,qz) + translation
t. The camera center in world coords is C = -R^T t, and the camera looks down
its local +z axis (forward = R^T [0,0,1]).
"""
import numpy as np
from pathlib import Path


def _quat_to_R(qw, qx, qy, qz):
    n = np.sqrt(qw*qw + qx*qx + qy*qy + qz*qz) or 1.0
    qw, qx, qy, qz = qw/n, qx/n, qy/n, qz/n
    return np.array([
        [1 - 2*(qy*qy+qz*qz), 2*(qx*qy - qz*qw),   2*(qx*qz + qy*qw)],
        [2*(qx*qy + qz*qw),   1 - 2*(qx*qx+qz*qz), 2*(qy*qz - qx*qw)],
        [2*(qx*qz - qy*qw),   2*(qy*qz + qx*qw),   1 - 2*(qx*qx+qy*qy)],
    ])


def parse_images_txt(model_dir: Path):
    """Return list of nodes: {name, position[x,y,z], forward[x,y,z], R(3x3 w2c)}."""
    path = model_dir / "images.txt"
    nodes = []
    lines = [l for l in path.read_text().splitlines() if l and not l.startswith("#")]
    # images.txt has TWO lines per image; the first holds the pose, second the 2D points
    for i in range(0, len(lines), 2):
        parts = lines[i].split()
        if len(parts) < 10:
            continue
        qw, qx, qy, qz = map(float, parts[1:5])
        tx, ty, tz = map(float, parts[5:8])
        name = parts[9]
        R = _quat_to_R(qw, qx, qy, qz)          # world -> camera
        t = np.array([tx, ty, tz])
        C = -R.T @ t                            # camera center in world
        fwd = R.T @ np.array([0, 0, 1.0])       # forward in world
        nodes.append({
            "name": name,
            "position": C.tolist(),
            "forward": fwd.tolist(),
            "R": R.tolist(),
        })
    return nodes
