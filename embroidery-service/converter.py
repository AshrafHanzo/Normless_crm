"""PNG/JPG logo -> DST embroidery file.

Satin, tatami fill, filled-with-a-satin-edge or a plain outline run, with underlay and automatic
thread-colour separation.

Satin is the stitch most of this trade actually uses: the thread lies across the shape in one
unbroken span, which is what gives lettering and narrow bars their sheen. It only works across a
narrow shape — past about a centimetre the span is long enough to snag and sag — so a shape wider
than that is filled with tatami instead, and the caller is told.

Because satin has to run across the *narrow* axis, each shape is measured, rotated onto its own
grain, stitched in rows, and rotated back. A vertical bar and a horizontal one therefore stitch
the same way, which is the thing a row-scanning digitizer normally gets wrong.
"""
import io, os, tempfile
import cv2, numpy as np, pyembroidery as pe


# How wide a shape can be before satin stops being sensible. Longer spans catch on everything
# and sag the first time the garment is worn; every machine shop has the same rule of thumb.
SATIN_MAX_MM = 10.0
# The width of a satin edge drawn around a tatami fill.
BORDER_MM = 1.6
STITCH_TYPES = ("auto", "satin", "tatami", "satin_border", "run")


def convert(image_bytes: bytes, width_mm: float = 100, colors="auto", underlay: bool = True,
            row_mm: float = 0.42, max_stitch_mm: float = 3.0, stitch_type: str = "auto"):
    """Returns (dst_bytes, preview_png_bytes, info_dict)."""
    if not 10 <= width_mm <= 400:
        raise ValueError("width_mm must be between 10 and 400")
    stitch_type = str(stitch_type or "auto").lower()
    if stitch_type not in STITCH_TYPES:
        raise ValueError(f"stitch_type must be one of: {', '.join(STITCH_TYPES)}")
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError("Could not read image (use PNG or JPG)")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    alpha = img[:, :, 3] if img.shape[2] == 4 else np.full(img.shape[:2], 255, np.uint8)
    bgr = img[:, :, :3]
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    fg = (alpha > 128) & ~((hsv[:, :, 2] > 235) & (hsv[:, :, 1] < 30))  # drop transparent/white bg
    if not fg.any():
        raise ValueError("Image has no artwork (only white/transparent)")
    ys, xs = np.where(fg)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    bgr, fg = bgr[y0:y1 + 1, x0:x1 + 1], fg[y0:y1 + 1, x0:x1 + 1]

    # --- colour separation (k-means in Lab) ---
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).reshape(-1, 3).astype(np.float32)
    px = lab[fg.reshape(-1)]
    sample = px[np.random.default_rng(0).choice(len(px), min(len(px), 40000), replace=False)]
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)

    def km(k):
        c, _, cent = cv2.kmeans(sample, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
        return c / len(sample), cent

    if str(colors) == "auto":
        k = 1
        while k < 8 and km(k)[0] > 150:
            k += 1
    else:
        k = max(1, min(12, int(colors)))
    _, cent = km(k)
    lbl = np.full(fg.size, -1)
    lbl[fg.reshape(-1)] = ((px[:, None, :] - cent[None]) ** 2).sum(2).argmin(1)
    lbl = lbl.reshape(fg.shape)

    mm = width_mm / fg.shape[1]
    U = mm * 10          # px -> 0.1 mm (DST units)
    row = row_mm / mm
    masks = []
    for i in range(k):
        m = cv2.morphologyEx((lbl == i).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        if int(m.sum()) * mm * mm < 1:
            continue  # specks / anti-alias fringe
        c = cv2.cvtColor(np.uint8([[cent[i]]]), cv2.COLOR_LAB2BGR)[0, 0]
        masks.append((int(m.sum()), m, (int(c[2]) << 16) | (int(c[1]) << 8) | int(c[0])))
    masks.sort(key=lambda t: -t[0])  # biggest area sews first

    def runs(r):
        d = np.diff(np.concatenate([[0], r, [0]]))
        return list(zip(np.where(d == 1)[0], np.where(d == -1)[0] - 1))

    def regions(m, step=None):
        step = row if step is None else step
        regs, prev = [], []
        for y in np.arange(0, m.shape[0], step):
            yi = int(round(y))
            if yi >= m.shape[0]:
                break
            rr, cur = runs(m[yi]), []
            for s, e in rr:
                if e - s < 1:
                    continue
                ov = [p for p in prev if p[0] <= e and p[1] >= s]
                r = None
                if len(ov) == 1 and len([c for c in rr if c[0] <= ov[0][1] and c[1] >= ov[0][0]]) == 1:
                    r = ov[0][2]
                if r is None:
                    regs.append([]); r = len(regs) - 1
                regs[r].append((y, s, e)); cur.append((s, e, r))
            prev = cur
        return regs

    def seg(p, q, out):
        n = int(np.ceil(np.hypot(q[0] - p[0], q[1] - p[1]) * mm / max_stitch_mm))
        for j in range(1, n):
            out.append((p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n))
        out.append(q)

    def zigzag_underlay(reg):
        st = max(1, int(round(1.6 / row_mm))); ins = 0.4 / mm
        rows = reg[::st]
        if reg[-1] is not rows[-1]:
            rows = rows + [reg[-1]]
        if len(rows) < 3 or any((e - s) * mm < 1.4 for _, s, e in rows):
            return []  # too thin for underlay
        pts = []
        for i, (y, s, e) in enumerate(rows):
            q = (s + ins if i % 2 == 0 else e - ins, y)
            seg(pts[-1], q, pts) if pts else pts.append(q)
        return pts

    def rotate_to_grain(m):
        """A shape turned so its narrow axis is vertical — satin then runs along the scan rows.

        Returns the rotated mask and the transform that puts a point back where it belongs.
        """
        pts = cv2.findNonZero(m)
        if pts is None or len(pts) < 5:
            return m, None, 0.0
        (_, _), (w, h), angle = cv2.minAreaRect(pts)
        # minAreaRect reports the angle of one side; turn whichever side is longer horizontal, so
        # the stitches cross the short way.
        if w < h:
            angle += 90
            w, h = h, w
        H, W = m.shape
        M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
        cos, sin = abs(M[0, 0]), abs(M[0, 1])
        nw, nh = int(H * sin + W * cos) + 2, int(H * cos + W * sin) + 2
        M[0, 2] += nw / 2 - W / 2
        M[1, 2] += nh / 2 - H / 2
        rot = cv2.warpAffine(m, M, (nw, nh), flags=cv2.INTER_NEAREST)
        return rot, cv2.invertAffineTransform(M), float(h)

    def unrotate(pts, Minv):
        if Minv is None:
            return pts
        a = np.array([[x, y, 1.0] for x, y in pts]).T
        out = Minv @ a
        return list(zip(out[0], out[1]))

    def satin(reg):
        """Thread laid straight across the shape, edge to edge — one span per row.

        No intermediate penetrations: that unbroken span is the whole point of satin, and it is
        why the width has to be kept in hand. A row too wide to cross in one stitch is split
        rather than dropped, which reads as a coarse fill and is the honest failure.
        """
        pts, limit = [], SATIN_MAX_MM / mm
        for i, (y, s, e) in enumerate(reg):
            a, b = (s, e) if i % 2 == 0 else (e, s)
            if abs(b - a) <= limit:
                pts.append((a, y))
                pts.append((b, y))
            else:
                pts.append((a, y))
                seg((a, y), (b, y), pts)
        return pts

    def centre_run(reg):
        """Underlay for satin: a line down the middle, which is what holds the column in place."""
        pts = []
        for y, s, e in reg[::max(1, int(round(1.2 / row_mm)))]:
            q = ((s + e) / 2, y)
            seg(pts[-1], q, pts) if pts else pts.append(q)
        return pts

    def outline(m, inset_mm=0.0):
        """The shape's edge as a path — a run stitch, or the spine of a satin border."""
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        paths = []
        for c in cs:
            if cv2.contourArea(c) * mm * mm < 1:
                continue
            c = cv2.approxPolyDP(c, max(0.35 / mm, 0.5), True).reshape(-1, 2).astype(float)
            if len(c) < 3:
                continue
            paths.append(c)
        return paths

    def run_path(path):
        pts = [tuple(path[0])]
        for q in list(path[1:]) + [path[0]]:
            seg(pts[-1], tuple(q), pts)
        return pts

    def satin_border(path):
        """A satin edge: the thread swinging either side of the outline as it travels it."""
        half = (BORDER_MM / 2) / mm
        step = max(1, int(round((row_mm * 1.1) / mm / max(0.6, row_mm / mm))))
        pts, n = [], len(path)
        for i in range(0, n + 1, step):
            p = path[i % n]
            nxt = path[(i + step) % n]
            dx, dy = nxt[0] - p[0], nxt[1] - p[1]
            L = np.hypot(dx, dy) or 1.0
            # Perpendicular to the direction of travel; the needle alternates across it.
            px, py = -dy / L * half, dx / L * half
            side = 1 if (i // step) % 2 == 0 else -1
            pts.append((p[0] + px * side, p[1] + py * side))
            pts.append((p[0] - px * side, p[1] - py * side))
        return pts

    def tatami(reg):
        pts = []
        for i, (y, s, e) in enumerate(reg):
            a, b = (s, e) if i % 2 == 0 else (e, s)
            n = max(1, int(np.ceil(abs(b - a) * mm / max_stitch_mm))); off = (i % 3) / 3
            for t in sorted({0, 1, *[min(1, (j + off) / n) for j in range(1, n)]}):
                pts.append((a + (b - a) * t, y))
        return pts

    # What each shape was actually stitched with, so the caller can be told rather than guess.
    used = set()
    laid = set()          # the underlay that actually went down, which differs by stitch
    too_wide = 0

    def shape_jobs(m):
        """One colour's artwork, broken into shapes, each with the stitch it is getting.

        A shape is measured before it is committed to: satin across a thirty-millimetre panel is
        a thread waiting to catch on something, so anything past the limit is filled instead —
        whatever was asked for. The count of those comes back as a warning.
        """
        nonlocal too_wide
        jobs = []
        n, labels = cv2.connectedComponents(m)
        for ci in range(1, n):
            part = (labels == ci).astype(np.uint8)
            if int(part.sum()) * mm * mm < 1:
                continue

            if stitch_type == 'run':
                for path in outline(part):
                    jobs.append(('run', run_path(path), part))
                continue

            # How wide the shape is across its narrow axis — the number satin lives or dies by.
            rot, Minv, narrow_px = rotate_to_grain(part)
            narrow_mm = narrow_px * mm
            wants_satin = stitch_type in ('satin', 'auto')
            if wants_satin and narrow_mm <= SATIN_MAX_MM:
                for reg in [r for r in regions(rot, row) if len(r) >= 2]:
                    under = centre_run(reg) if underlay else []
                    if under:
                        laid.add('centre run')
                    pts = under + satin(reg)
                    jobs.append(('satin', unrotate(pts, Minv), part))
                continue
            if wants_satin:
                too_wide += 1

            for reg in [r for r in regions(part) if len(r) >= 2]:
                under = zigzag_underlay(reg) if underlay else []
                if under:
                    laid.add('zigzag')
                jobs.append(('tatami', under + tatami(reg[::-1]), part))
            if stitch_type == 'satin_border':
                for path in outline(part):
                    jobs.append(('satin_border', satin_border(path), part))
        return jobs

    pat = pe.EmbPattern(); cur = None
    for ci, (_, m, col) in enumerate(masks):
        pat.add_thread(pe.EmbThread(col))
        jobs = [j for j in shape_jobs(m) if len(j[1]) >= 2]
        left = list(range(len(jobs)))
        while left:
            idx = left[0] if cur is None else min(
                left, key=lambda i: (jobs[i][1][0][0] - cur[0]) ** 2 + (jobs[i][1][0][1] - cur[1]) ** 2)
            left.remove(idx)
            kind, pts, part = jobs[idx]
            used.add(kind)
            sx, sy = pts[0]
            if cur is not None:
                dist = np.hypot(sx - cur[0], sy - cur[1]) * mm
                inside = all(m[min(m.shape[0] - 1, max(0, int(round(cur[1] + (sy - cur[1]) * t)))),
                               min(m.shape[1] - 1, max(0, int(round(cur[0] + (sx - cur[0]) * t))))]
                             for t in np.linspace(0, 1, 40))
                if dist > 2 or not inside:
                    if dist > 6 or not inside:
                        pat.add_command(pe.TRIM)
                    pat.add_stitch_absolute(pe.JUMP, sx * U, sy * U)
            for x, y in pts:
                pat.add_stitch_absolute(pe.STITCH, x * U, y * U)
            cur = pts[-1]
        pat.add_command(pe.TRIM)
        if ci < len(masks) - 1:
            pat.add_command(pe.COLOR_CHANGE)
    pat.add_command(pe.END)

    with tempfile.TemporaryDirectory() as td:
        dst_path, png_path = os.path.join(td, "d.dst"), os.path.join(td, "p.png")
        pe.write_dst(pat.get_normalized_pattern(), dst_path,
                     {"long_stitch_contingency": pe.CONTINGENCY_LONG_STITCH_SEW_TO,
                      "max_stitch": 121, "max_jump": 121})
        p = pe.read(dst_path)
        p.threadlist = [pe.EmbThread(c) for _, _, c in masks]
        pe.write_png(p, png_path, {"linewidth": 4, "background": "#FFFFFF", "fancy": True})
        dst_bytes, png_bytes = open(dst_path, "rb").read(), open(png_path, "rb").read()

    warnings = []
    height_mm = fg.shape[0] * mm
    if width_mm < 60:
        warnings.append("Small size: fine lines and small text may stitch rough.")
    if too_wide:
        warnings.append(
            f"{too_wide} shape{'s are' if too_wide > 1 else ' is'} wider than {SATIN_MAX_MM:.0f}mm — "
            "filled with tatami instead, because a satin span that long snags and sags.")
    info = {
        "width_mm": round(width_mm, 1),
        "height_mm": round(height_mm, 1),
        "stitch_count": sum(1 for s in p.stitches if s[2] == pe.STITCH),
        "thread_colors": [f"#{c:06X}" for _, _, c in masks],  # sewing order
        "stitch_type": stitch_type,
        # What came out, rather than what was asked for: the two differ whenever a shape was too
        # wide for satin, and the person at the machine should see which.
        "fill": " + ".join(sorted(used)) or "none",
        "underlay": " + ".join(sorted(laid)) or "none",
        "warnings": warnings,
    }
    return dst_bytes, png_bytes, info


if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser(description="PNG -> DST embroidery")
    ap.add_argument("input"); ap.add_argument("--width-mm", type=float, default=100)
    ap.add_argument("--colors", default="auto"); ap.add_argument("--no-underlay", action="store_true")
    ap.add_argument("--stitch-type", default="auto", choices=STITCH_TYPES)
    ap.add_argument("--out", default="design.dst"); ap.add_argument("--preview", default="preview.png")
    a = ap.parse_args()
    d, pv, info = convert(open(a.input, "rb").read(), a.width_mm, a.colors, not a.no_underlay,
                          stitch_type=a.stitch_type)
    open(a.out, "wb").write(d); open(a.preview, "wb").write(pv)
    print(json.dumps(info, indent=2))
