"""FunSync Player — Python Backend (FastAPI)"""

import argparse
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.scripts import router as scripts_router
from routes.thumbnails import router as thumbnails_router
from routes.metadata import router as metadata_router

app = FastAPI(title="FunSync Backend", version="0.1.0")

# Allow Electron renderer to call the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(scripts_router, prefix="/scripts", tags=["scripts"])
app.include_router(thumbnails_router, prefix="/thumbnails", tags=["thumbnails"])
app.include_router(metadata_router, prefix="/metadata", tags=["metadata"])


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5123)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port)
