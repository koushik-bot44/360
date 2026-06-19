"""Full product pipeline on REAL reconstruction (not mock).

Uploads the synthetic-room photos through the actual API, runs reconstruction
with the real engine (pycolmap), builds the auto graph, and saves the resulting
tour.json to samples/sample_tour_colmap.json — proof of the whole chain:

    photos -> pycolmap poses -> auto nodes + hotspots -> viewer-ready tour.json

Run from backend/:   python scripts/real_tour_demo.py
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402
from app.pipeline import colmap_runner  # noqa: E402
from scripts.make_synthetic_room import render  # noqa: E402

client = TestClient(app)


def main():
    img_dir = ROOT / "data" / "synthetic_room"
    if not (img_dir / "ground_truth.json").exists():
        render(img_dir, 20)
    frames = sorted(img_dir.glob("frame_*.jpg"))

    print("engine:", client.get("/health").json()["engine"])
    if colmap_runner.engine_name() == "mock":
        print("FAIL: no real engine available."); sys.exit(1)

    jid = client.post("/tours", json={"title": "Synthetic Room (real COLMAP)"}).json()["id"]
    files = [("files", (f.name, f.read_bytes(), "image/jpeg")) for f in frames]
    up = client.post(f"/tours/{jid}/photos", files=files).json()
    print(f"uploaded {up['num_images']} photos, job {jid}")

    client.post(f"/tours/{jid}/reconstruct")
    for _ in range(600):                 # background task runs in-process
        st = client.get(f"/tours/{jid}").json()
        if st["status"] in ("ready", "failed"):
            break
        time.sleep(0.2)
    print("status:", st["status"], "engine:", st["engine"], "error:", st.get("error"))
    assert st["status"] == "ready", "reconstruction failed"

    tour = client.get(f"/tours/{jid}/tour.json").json()
    n_scenes = len(tour["scenes"])
    n_hot = sum(len(s["hotspots"]) for s in tour["scenes"])
    print(f"tour.json: {n_scenes} nodes, {n_hot} auto-hotspots, engine={tour['_meta']['engine']}")

    out = ROOT / "samples" / "sample_tour_colmap.json"
    out.write_text(json.dumps(tour, indent=2))
    print("wrote", out.relative_to(ROOT))
    print("PASS — full pipeline produced a real-reconstruction tour.")


if __name__ == "__main__":
    main()
