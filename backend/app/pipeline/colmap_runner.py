"""Run COLMAP Structure-from-Motion as a subprocess.

This is the real reconstruction path. It is *optional*: if the `colmap` binary
is not on PATH, `is_available()` returns False and the orchestrator falls back
to the mock-pose path so the POC still runs end-to-end.
"""
import shutil
import subprocess
from pathlib import Path


def is_available() -> bool:
    return shutil.which("colmap") is not None


def run(images_dir: Path, work_dir: Path) -> Path:
    """Run feature extraction → matching → mapping.

    Returns the path to the sparse model dir (containing images.txt/.bin).
    Raises RuntimeError if COLMAP fails or produces no model.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    db_path = work_dir / "database.db"
    sparse_dir = work_dir / "sparse"
    sparse_dir.mkdir(exist_ok=True)

    def colmap(*args):
        cmd = ["colmap", *map(str, args)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"COLMAP step failed: {' '.join(cmd)}\n{proc.stderr[-2000:]}")

    # 1) features  2) match (sequential = ordered capture)  3) sparse map
    colmap("feature_extractor", "--database_path", db_path,
           "--image_path", images_dir, "--ImageReader.single_camera", "1")
    colmap("sequential_matcher", "--database_path", db_path)
    colmap("mapper", "--database_path", db_path,
           "--image_path", images_dir, "--output_path", sparse_dir)

    # COLMAP writes models into sparse/0, sparse/1, ... pick the largest
    models = sorted([p for p in sparse_dir.iterdir() if p.is_dir()],
                    key=lambda p: p.name)
    if not models:
        raise RuntimeError("COLMAP produced no sparse model (too few matches?)")

    # Convert binary model to TXT so poses.py can parse without pycolmap
    model = models[0]
    colmap("model_converter", "--input_path", model,
           "--output_path", model, "--output_type", "TXT")
    return model
