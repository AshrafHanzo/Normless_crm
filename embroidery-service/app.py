"""Embroidery converter API.
POST /convert  (multipart: file, width_mm, colors, underlay, stitch_type) -> JSON with DST + preview as base64
POST /convert/dst  same inputs -> raw .dst file download
GET  /health
Optional auth: set EMB_API_KEY env var; callers send header  X-API-Key: <key>
"""
import base64, os, re
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.concurrency import run_in_threadpool
from converter import convert, STITCH_TYPES

API_KEY = os.getenv("EMB_API_KEY")
MAX_BYTES = 15 * 1024 * 1024
app = FastAPI(title="Embroidery Converter", version="1.0")
app.add_middleware(CORSMiddleware,
                   allow_origins=[o for o in os.getenv("EMB_ALLOWED_ORIGINS", "*").split(",") if o],
                   allow_methods=["*"], allow_headers=["*"])


def _check_key(key):
    if API_KEY and key != API_KEY:
        raise HTTPException(401, "Invalid or missing X-API-Key")


async def _run(file, width_mm, colors, underlay, stitch_type="auto"):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image larger than 15 MB")
    if stitch_type not in STITCH_TYPES:
        raise HTTPException(400, f"stitch_type must be one of: {', '.join(STITCH_TYPES)}")
    try:
        return await run_in_threadpool(convert, data, width_mm, colors, underlay,
                                       stitch_type=stitch_type)
    except ValueError as e:
        raise HTTPException(400, str(e))


def _name(filename, width_mm):
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", os.path.splitext(filename or "design")[0]).strip("_") or "design"
    return f"{base}_{int(round(width_mm))}mm"


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/convert")
async def convert_json(file: UploadFile = File(...), width_mm: float = Form(100),
                       colors: str = Form("auto"), underlay: bool = Form(True),
                       stitch_type: str = Form("auto"),
                       x_api_key: str | None = Header(None)):
    _check_key(x_api_key)
    dst, png, info = await _run(file, width_mm, colors, underlay, stitch_type)
    name = _name(file.filename, width_mm)
    return {"filename": f"{name}.dst", "info": info,
            "dst_base64": base64.b64encode(dst).decode(),
            "preview_png_base64": base64.b64encode(png).decode()}


@app.post("/convert/dst")
async def convert_file(file: UploadFile = File(...), width_mm: float = Form(100),
                       colors: str = Form("auto"), underlay: bool = Form(True),
                       stitch_type: str = Form("auto"),
                       x_api_key: str | None = Header(None)):
    _check_key(x_api_key)
    dst, _, info = await _run(file, width_mm, colors, underlay, stitch_type)
    return Response(dst, media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{_name(file.filename, width_mm)}.dst"',
                             "X-Stitch-Count": str(info["stitch_count"]),
                             "X-Thread-Colors": ",".join(info["thread_colors"])})
