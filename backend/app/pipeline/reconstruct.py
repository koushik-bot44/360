"""Orchestrates one reconstruction job: photos -> poses -> graph -> tour.json.

Uses COLMAP when available, otherwise the mock-pose path. Designed to run in a
background task (it can take minutes with real COLMAP).
"""
import json
import traceback
from pathlib import Path

from . import colmap_runner, poses as poses_mod, graph as graph_mod, export, mock
from .. import db

IMG_EXTS = {".jpg", ".jpeg", ".png"}


def run_job(job_id: str, job_dir: Path, image_base_url: str):
    images_dir = job_dir / "images"
    names = sorted(p.name for p in images_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
    job = db.get_job(job_id) or {}
    title = job.get("title", "Reconstructed Tour")

    try:
        if not names:
            raise RuntimeError("no images uploaded")

        if colmap_runner.is_available():
            engine = "colmap"
            db.update_job(job_id, status="reconstructing", engine=engine)
            model_dir = colmap_runner.run(images_dir, job_dir / "colmap")
            nodes = poses_mod.parse_images_txt(model_dir)
            if not nodes:
                raise RuntimeError("COLMAP registered no images")
        else:
            engine = "mock"
            db.update_job(job_id, status="reconstructing", engine=engine)
            nodes = mock.generate(names)

        scenes = graph_mod.build(nodes)
        tour = export.to_tour_json(job_id, title, scenes, image_base_url, engine)
        (job_dir / "tour.json").write_text(json.dumps(tour, indent=2))
        db.update_job(job_id, status="ready", engine=engine, num_images=len(names), error=None)
        return tour

    except Exception as e:  # noqa
        db.update_job(job_id, status="failed", error=f"{e}")
        traceback.print_exc()
        raise
