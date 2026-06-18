"""Pydantic response models."""
from typing import Optional, List
from pydantic import BaseModel


class JobCreate(BaseModel):
    title: str = "Reconstructed Tour"


class JobStatus(BaseModel):
    id: str
    title: str
    status: str
    engine: str = ""
    num_images: int = 0
    error: Optional[str] = None
    tour_url: Optional[str] = None


class JobList(BaseModel):
    jobs: List[JobStatus]
