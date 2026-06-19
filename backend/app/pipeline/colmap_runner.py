"""Run COLMAP Structure-from-Motion.

Two real engines are supported, in order of preference:

1. **pycolmap** — COLMAP's engine as a pip wheel (`pip install pycolmap`). No
   system install / sudo needed. This is the default on this machine.
2. **colmap CLI** — the `colmap` binary on PATH (`brew install colmap`, etc.).

If neither is present, `is_available()` returns False and the orchestrator falls
back to the mock-pose path so the POC still runs end-to-end.

Either engine produces a COLMAP sparse model written as TEXT (`images.txt` etc.)
so `poses.py` can parse it identically.
"""
import shutil
import subprocess
from pathlib import Path

try:
    import pycolmap  # type: ignore
    _HAS_PYCOLMAP = True
except Exception:  # noqa
    _HAS_PYCOLMAP = False


def is_available() -> bool:
    return _HAS_PYCOLMAP or shutil.which("colmap") is not None


def engine_name() -> str:
    if _HAS_PYCOLMAP:
        return "pycolmap"
    if shutil.which("colmap"):
        return "colmap-cli"
    return "mock"


def run(images_dir: Path, work_dir: Path) -> Path:
    """Run feature extraction → matching → mapping.

    Returns the path to the sparse model dir (containing images.txt).
    Raises RuntimeError if reconstruction fails or produces no model.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    if _HAS_PYCOLMAP:
        return _run_pycolmap(images_dir, work_dir)
    return _run_cli(images_dir, work_dir)


# --------------------------------------------------------------------------- #
# pycolmap (default)
# --------------------------------------------------------------------------- #
def _run_pycolmap(images_dir: Path, work_dir: Path) -> Path:
    db_path = work_dir / "database.db"
    sparse_dir = work_dir / "sparse"
    sparse_dir.mkdir(exist_ok=True)
    if db_path.exists():
        db_path.unlink()  # fresh DB so re-runs don't duplicate features

    # 1) SIFT features  2) exhaustive match (robust for small ordered sets)
    pycolmap.extract_features(database_path=str(db_path), image_path=str(images_dir))
    pycolmap.match_exhaustive(database_path=str(db_path))

    # 3) incremental SfM -> {model_index: Reconstruction}
    recs = pycolmap.incremental_mapping(
        database_path=str(db_path),
        image_path=str(images_dir),
        output_path=str(sparse_dir),
    )
    if not recs:
        raise RuntimeError(
            "pycolmap registered no images (too few matches — low texture or "
            "insufficient overlap between photos?)"
        )

    # Pick the reconstruction that registered the most images
    best_idx = max(recs, key=lambda i: recs[i].num_reg_images())
    rec = recs[best_idx]
    model = sparse_dir / str(best_idx)
    model.mkdir(parents=True, exist_ok=True)
    rec.write_text(str(model))   # images.txt / cameras.txt / points3D.txt
    return model


# --------------------------------------------------------------------------- #
# colmap CLI (fallback if pycolmap unavailable but the binary is installed)
# --------------------------------------------------------------------------- #
def _run_cli(images_dir: Path, work_dir: Path) -> Path:
    db_path = work_dir / "database.db"
    sparse_dir = work_dir / "sparse"
    sparse_dir.mkdir(exist_ok=True)

    def colmap(*args):
        cmd = ["colmap", *map(str, args)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"COLMAP step failed: {' '.join(cmd)}\n{proc.stderr[-2000:]}")

    colmap("feature_extractor", "--database_path", db_path,
           "--image_path", images_dir, "--ImageReader.single_camera", "1")
    colmap("exhaustive_matcher", "--database_path", db_path)
    colmap("mapper", "--database_path", db_path,
           "--image_path", images_dir, "--output_path", sparse_dir)

    models = sorted([p for p in sparse_dir.iterdir() if p.is_dir()], key=lambda p: p.name)
    if not models:
        raise RuntimeError("COLMAP produced no sparse model (too few matches?)")

    model = models[0]
    colmap("model_converter", "--input_path", model,
           "--output_path", model, "--output_type", "TXT")
    return model
