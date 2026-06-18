"""End-to-end smoke test of the reconstruction POC (no server, no COLMAP needed).

Generates a few test photos, runs the full API flow in-process via TestClient,
and verifies a tour.json with auto-generated nodes + hotspots comes out.

Run from the backend/ folder:   python scripts/smoke_test.py
"""
import io
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PIL import Image
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def make_photo(hue):
    img = Image.new("RGB", (640, 480), (hue % 255, (hue * 2) % 255, (hue * 3) % 255))
    buf = io.BytesIO(); img.save(buf, "JPEG"); buf.seek(0)
    return buf.read()


def main():
    h = client.get("/health").json()
    print("health:", h)

    job = client.post("/tours", json={"title": "Smoke Test Room"}).json()
    jid = job["id"]
    print("created job:", jid, "status:", job["status"])

    files = [("files", (f"photo_{i:02d}.jpg", make_photo(i * 18), "image/jpeg")) for i in range(12)]
    up = client.post(f"/tours/{jid}/photos", files=files).json()
    print("uploaded:", up["num_images"], "photos")

    client.post(f"/tours/{jid}/reconstruct")
    # background task runs after the response; poll status
    for _ in range(50):
        st = client.get(f"/tours/{jid}").json()
        if st["status"] in ("ready", "failed"):
            break
        time.sleep(0.1)
    print("status:", st["status"], "engine:", st["engine"], "error:", st.get("error"))
    assert st["status"] == "ready", "reconstruction did not complete"

    tour = client.get(f"/tours/{jid}/tour.json").json()
    n_scenes = len(tour["scenes"])
    n_hotspots = sum(len(s["hotspots"]) for s in tour["scenes"])
    print(f"tour.json: {n_scenes} nodes, {n_hotspots} auto-hotspots, engine={tour['_meta']['engine']}")
    print("startScene:", tour["startScene"], "| sample image url:", tour["scenes"][0]["image"])
    assert n_scenes == 12 and n_hotspots > 0

    # save a sample for the repo
    samples = ROOT / "samples"; samples.mkdir(exist_ok=True)
    (samples / "sample_tour.json").write_text(__import__("json").dumps(tour, indent=2))
    print("\nPASS — wrote samples/sample_tour.json")
    print("Load it in the viewer:  /builder.html?tour=<backend-url>/tours/%s/tour.json" % jid)


if __name__ == "__main__":
    main()
