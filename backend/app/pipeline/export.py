"""Export the auto-generated graph as a tour.json the existing Three.js viewer
already understands (same schema as the front-end TourStore)."""


def to_tour_json(job_id, title, scenes, image_base_url, engine):
    out_scenes = []
    for s in scenes:
        out_scenes.append({
            "id": s["id"],
            "name": s["name"],
            "image": f"{image_base_url}/{s['_image_name']}",
            "floor": s.get("floor", "Ground Floor"),
            "hotspots": s["hotspots"],
        })
    return {
        "id": job_id,
        "title": title,
        "details": {
            "description": f"Auto-generated from {len(out_scenes)} photos "
                           f"using {engine} camera-pose estimation.",
            "amenities": "Auto-generated, Camera poses, Node graph",
        },
        "floors": ["Ground Floor"],
        "startScene": out_scenes[0]["id"] if out_scenes else None,
        "scenes": out_scenes,
        "_meta": {"engine": engine, "generated": True},
    }
