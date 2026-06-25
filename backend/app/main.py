"""FastAPI app — local proof-of-concept API.

Flow:
  POST /panorama                    -> stitch overlapping photos into one 360° pano
  POST /tours                       -> create a job
  POST /tours/{id}/photos           -> upload 10-30 phone photos (multipart)
  POST /tours/{id}/reconstruct      -> run pose estimation + graph (background)
  GET  /tours/{id}                  -> status (+ tour_url when ready)
  GET  /tours/{id}/tour.json        -> the generated tour (loadable by the viewer)
  GET  /tours/{id}/images/<file>    -> the uploaded photos
"""
import base64
import shutil
import tempfile
import uuid
from pathlib import Path

import cv2

from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .schemas import JobCreate, JobStatus, JobList
from .pipeline.reconstruct import run_job
from .pipeline import colmap_runner
from .pipeline.stitch import stitch_panorama, parse_orientation
from .pipeline.link import link_panos

import numpy as np

DATA = Path(__file__).resolve().parent.parent / "data" / "jobs"
DATA.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="360 Tour — Phase 2 reconstruction POC")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)
db.init()

# serve uploaded photos (CORS-enabled so the front-end TextureLoader can read them)
app.mount("/files", StaticFiles(directory=DATA), name="files")


def job_dir(job_id: str) -> Path:
    return DATA / job_id


def _status(job, request: Request) -> JobStatus:
    tour_url = None
    if job["status"] == "ready":
        tour_url = str(request.base_url).rstrip("/") + f"/tours/{job['id']}/tour.json"
    return JobStatus(tour_url=tour_url, **{k: job[k] for k in
                     ("id", "title", "status", "engine", "num_images", "error")})


@app.get("/health")
def health():
    return {"ok": True, "colmap": colmap_runner.is_available(),
            "engine": colmap_runner.engine_name()}


@app.post("/panorama")
async def panorama(files: list[UploadFile] = File(...)):
    """Stitch 10–20 overlapping photos (taken by rotating in place) into one
    equirectangular panorama. Returns the image as a data URL plus debug info
    (images used, matched features, success/failure reason, output resolution).
    """
    tmp = Path(tempfile.mkdtemp(prefix="pano_"))
    try:
        paths = []
        orientations = []                       # per-photo capture angle (guided capture)
        for i, f in enumerate(files):
            data = await f.read()
            if not data:
                continue
            ext = Path(f.filename or "").suffix.lower() or ".jpg"
            p = tmp / f"{i:03d}{ext}"
            p.write_bytes(data)
            paths.append(p)
            orientations.append(parse_orientation(f.filename or ""))

        # ARCHIVE every capture's input photos (angle-named, so any past capture can
        # be re-stitched without re-shooting) under data/captures/cap_NNNN/ — no
        # longer overwriting the previous one. data/last_capture mirrors the latest
        # for convenience. We keep the 15 most recent archives.
        cap_dir = None
        try:
            caps = DATA.parent / "captures"
            caps.mkdir(parents=True, exist_ok=True)
            nums = [int(d.name[4:]) for d in caps.glob("cap_*") if d.name[4:].isdigit()]
            cap_dir = caps / f"cap_{(max(nums) + 1 if nums else 1):04d}"
            cap_dir.mkdir()
            for f, p in zip(files, paths):
                name = Path(f.filename or "").name or p.name
                shutil.copy2(p, cap_dir / name)
            last = DATA.parent / "last_capture"          # mirror the most recent
            shutil.rmtree(last, ignore_errors=True)
            shutil.copytree(cap_dir, last)
            for old in sorted(caps.glob("cap_*"))[:-15]:  # keep the 15 newest
                shutil.rmtree(old, ignore_errors=True)
        except Exception:
            cap_dir = None

        equirect, debug = stitch_panorama(paths, orientations=orientations)
        # Coverage: how much of the 2:1 sphere actually has imagery (not the black
        # pad). Low coverage ⇒ the capture didn't span the full sphere — the real
        # cause of "bad stitching" far more often than the stitch algorithm.
        if equirect is not None:
            g = cv2.cvtColor(equirect, cv2.COLOR_BGR2GRAY)
            debug["coverage_pct"] = round(float((g > 24).mean()) * 100, 1)
        print(
            f"[panorama] in={debug.get('num_images_input')} used={debug.get('num_images_used')} "
            f"matches={debug.get('num_matches')} engine={debug.get('engine')} "
            f"coverage={debug.get('coverage_pct')}% "
            f"-> {debug.get('status')}: {debug.get('reason')}"
            + (f" (hugin fell back: {debug['hugin_reason']})" if debug.get('hugin_reason') else ""),
            flush=True,
        )
        if equirect is None:
            return JSONResponse(status_code=422, content={"ok": False, **debug})

        ok, buf = cv2.imencode(".jpg", equirect, [cv2.IMWRITE_JPEG_QUALITY, 88])
        if not ok:
            raise HTTPException(500, "failed to encode panorama")
        # Keep the last stitched panorama on disk for inspection/debugging.
        try:
            dbg = DATA.parent / "last_panorama.jpg"
            dbg.write_bytes(buf.tobytes())
            if cap_dir:                       # keep the result alongside its capture
                (cap_dir / "result.jpg").write_bytes(buf.tobytes())
        except Exception:
            pass
        data_url = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
        return {"ok": True, "image": data_url, **debug}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _decode(upload_bytes):
    arr = np.frombuffer(upload_bytes, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


@app.post("/link")
async def link(a: UploadFile = File(...), b: UploadFile = File(...)):
    """Estimate the bearing connecting two panoramas (for auto-generated hotspots).
    Returns dirA (heading in A toward B), dirB (heading in B toward A), and the
    match/inlier/confidence stats. `linked` is false when the pair doesn't overlap
    enough to be considered connected.
    """
    imgA, imgB = _decode(await a.read()), _decode(await b.read())
    if imgA is None or imgB is None:
        raise HTTPException(422, "could not decode one of the images")
    return link_panos(imgA, imgB)


@app.post("/tours", response_model=JobStatus)
def create_tour(body: JobCreate, request: Request):
    job_id = "tour_" + uuid.uuid4().hex[:10]
    (job_dir(job_id) / "images").mkdir(parents=True, exist_ok=True)
    db.create_job(job_id, body.title)
    return _status(db.get_job(job_id), request)


@app.post("/tours/{job_id}/photos", response_model=JobStatus)
async def upload_photos(job_id: str, request: Request, files: list[UploadFile] = File(...)):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    imgs = job_dir(job_id) / "images"
    imgs.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in files:
        if not f.filename:
            continue
        (imgs / Path(f.filename).name).write_bytes(await f.read())
        n += 1
    db.update_job(job_id, status="uploaded", num_images=n)
    return _status(db.get_job(job_id), request)


@app.post("/tours/{job_id}/reconstruct", response_model=JobStatus)
def reconstruct(job_id: str, background: BackgroundTasks, request: Request):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    base = str(request.base_url).rstrip("/") + f"/files/{job_id}/images"
    db.update_job(job_id, status="reconstructing")
    background.add_task(run_job, job_id, job_dir(job_id), base)
    return _status(db.get_job(job_id), request)


@app.get("/tours/{job_id}", response_model=JobStatus)
def get_tour(job_id: str, request: Request):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return _status(job, request)


@app.get("/tours/{job_id}/tour.json")
def get_tour_json(job_id: str):
    p = job_dir(job_id) / "tour.json"
    if not p.exists():
        raise HTTPException(404, "not ready")
    return JSONResponse(content=__import__("json").loads(p.read_text()))


@app.get("/tours", response_model=JobList)
def list_tours(request: Request):
    return JobList(jobs=[_status(j, request) for j in db.list_jobs()])
