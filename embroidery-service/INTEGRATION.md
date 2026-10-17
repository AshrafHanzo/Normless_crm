# Embroidery Converter: CRM integration

Converts a logo PNG/JPG into a machine-ready **DST** file (tatami fill, zigzag underlay, automatic thread colours) and returns a stitch preview.

## What's in this folder

| File | What it is |
|---|---|
| `converter.py` | The digitizing engine. Also works on its own from the command line. |
| `app.py` | Small web API (FastAPI) around the engine |
| `requirements.txt`, `Dockerfile` | Everything needed to run it on your server |
| `embroidery-widget.html` | Ready-made upload form for a CRM page |

## 1. Run the service on your CRM server

**With Docker (recommended):**

```bash
cd embroidery-service
docker build -t embroidery-converter .
docker run -d --name embroidery --restart unless-stopped \
  -p 127.0.0.1:8090:8090 \
  -e EMB_API_KEY=choose-a-long-random-key \
  embroidery-converter
curl http://127.0.0.1:8090/health      # -> {"ok":true}
```

**Without Docker (Python 3.10+):**

```bash
pip install -r requirements.txt
EMB_API_KEY=choose-a-long-random-key uvicorn app:app --host 127.0.0.1 --port 8090 --workers 2
```

Run it under systemd or pm2 so it restarts with the server. It listens only on `127.0.0.1`, so only your CRM backend can reach it, not the public internet.

Quick test from the command line:

```bash
python converter.py logo.png --width-mm 100 --out logo.dst --preview logo_preview.png
```

## 2. API reference

All requests are `multipart/form-data` with header `X-API-Key: <EMB_API_KEY>`.

| Field | Default | Notes |
|---|---|---|
| `file` | required | PNG or JPG, max 15 MB. White or transparent background is ignored. |
| `width_mm` | `100` | Finished width, 10–400 mm. Height scales automatically. |
| `colors` | `auto` | Number of thread colours, or `auto` to detect them |
| `underlay` | `true` | Zigzag underlay on or off |

**`POST /convert`** returns JSON:

```json
{
  "filename": "logo_100mm.dst",
  "info": {"width_mm": 100, "height_mm": 25.4, "stitch_count": 1745,
           "thread_colors": ["#00478F", "#FF7813"], "fill": "tatami",
           "underlay": "zigzag", "warnings": []},
  "dst_base64": "...",
  "preview_png_base64": "..."
}
```

**`POST /convert/dst`** returns the raw `.dst` file as a download. Response headers: `X-Stitch-Count`, `X-Thread-Colors`.

Errors come back as HTTP 400 (bad image or size), 401 (wrong key) or 413 (file too large), each with `{"detail": "..."}`.

## 3. Wire it into the CRM with Claude

Open your CRM project in Claude (Claude Code or wherever you build it), add this folder to the repo, and paste the prompt below:

> I've added an `embroidery-service/` folder to this repo. It's a FastAPI service that converts logo images to DST embroidery files. Read `embroidery-service/INTEGRATION.md` for the API.
>
> Integrate it into our CRM:
> 1. **Backend proxy route** `POST /api/embroidery/convert`, available only to logged-in CRM users. It forwards the multipart upload (`file`, `width_mm`, `colors`, `underlay`) to `http://127.0.0.1:8090/convert` with header `X-API-Key` taken from a new env var `EMB_API_KEY`, and returns the JSON response. Never send the API key to the browser.
> 2. **On the order/deal detail page**, add a "Make DST file" section based on `embroidery-service/embroidery-widget.html`. Restyle it to match our UI, keep its behaviour, and point its ENDPOINT at the proxy route.
> 3. **Save the results to the record.** After a successful conversion, store the original logo, the `.dst` file and the preview PNG as attachments on that order, along with width, stitch count and thread colours. Use the same storage the CRM already uses for attachments. List previous conversions for the order with download links.
> 4. Add the service to our deployment (docker-compose or systemd, whichever we use) and add `EMB_API_KEY` to `.env.example`.
> 5. Test end to end with a sample PNG and show me the result.

## Notes for production

- **Size presets** worth adding to the UI: chest 9–10 cm, cap front 5.5–6 cm, sleeve 7 cm, full back 25 cm.
- **Thread colours:** DST files carry no colour information. Show `thread_colors` on the job sheet so the machine operator loads the right threads.
- **Speed:** a typical logo converts in 1–3 seconds. With `--workers 2`, two conversions run at once. Raise the worker count if many staff will convert at the same time.
- **Quality limits:** results are good for flat-colour logos and text. Photos, gradients, lines under about 1 mm and text under about 6 mm tall need a professional digitizer. Always test-stitch a new logo before a bulk run.
