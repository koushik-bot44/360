"""FastAPI app — local proof-of-concept API.

Flow:
  POST /tours                       -> create a job
  POST /tours/{id}/photos           -> upload 10-30 phone photos (multipart)
  POST /tours/{id}/reconstruct      -> run pose estimation + graph (background)
  GET  /tours/{id}                  -> status (+ tour_url when ready)
  GET  /tours/{id}/tour.json        -> the generated tour (loadable by the viewer)
  GET  /tours/{id}/images/<file>    -> the uploaded photos
"""
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .schemas import JobCreate, JobStatus, JobList
from .pipeline.reconstruct import run_job
from .pipeline import colmap_runner

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
            "engine": "colmap" if colmap_runner.is_available() else "mock"}


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
