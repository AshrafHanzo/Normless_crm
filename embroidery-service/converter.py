"""PNG/JPG logo -> DST embroidery file.
Tatami fill + zigzag underlay, automatic thread-colour separation.
"""
import io, os, tempfile
import cv2, numpy as np, pyembroidery as pe


def convert(image_bytes: bytes, width_mm: float = 100, colors="auto", underlay: bool = True,
            row_mm: float = 0.42, max_stitch_mm: float = 3.0):
    """Returns (dst_bytes, preview_png_bytes, info_dict)."""
    if not 10 <= width_mm <= 400:
        raise ValueError("width_mm must be between 10 and 400")
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

    def regions(m):
        regs, prev = [], []
        for y in np.arange(0, m.shape[0], row):
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

    def tatami(reg):
        pts = []
        for i, (y, s, e) in enumerate(reg):
            a, b = (s, e) if i % 2 == 0 else (e, s)
            n = max(1, int(np.ceil(abs(b - a) * mm / max_stitch_mm))); off = (i % 3) / 3
            for t in sorted({0, 1, *[min(1, (j + off) / n) for j in range(1, n)]}):
                pts.append((a + (b - a) * t, y))
        return pts

    pat = pe.EmbPattern(); cur = None
    for ci, (_, m, col) in enumerate(masks):
        pat.add_thread(pe.EmbThread(col))
        regs = [r for r in regions(m) if len(r) >= 2]
        left = list(range(len(regs)))
        while left:
            idx = left[0] if cur is None else min(
                left, key=lambda i: (regs[i][0][1] - cur[0]) ** 2 + (regs[i][0][0] - cur[1]) ** 2)
            left.remove(idx); reg = regs[idx]
            pts = (zigzag_underlay(reg) if underlay else []) + tatami(reg[::-1])
            sx, sy = pts[0]
            if cur is not None:
                dist = np.hypot(sx - cur[0], sy - cur[1]) * mm
                inside = all(m[min(m.shape[0] - 1, int(round(cur[1] + (sy - cur[1]) * t))),
                               min(m.shape[1] - 1, int(round(cur[0] + (sx - cur[0]) * t)))]
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
    info = {
        "width_mm": round(width_mm, 1),
        "height_mm": round(height_mm, 1),
        "stitch_count": sum(1 for s in p.stitches if s[2] == pe.STITCH),
        "thread_colors": [f"#{c:06X}" for _, _, c in masks],  # sewing order
        "fill": "tatami", "underlay": "zigzag" if underlay else "none",
        "warnings": warnings,
    }
    return dst_bytes, png_bytes, info


if __name__ == "__main__":
    import argparse, json
    ap = argparse.ArgumentParser(description="PNG -> DST embroidery")
    ap.add_argument("input"); ap.add_argument("--width-mm", type=float, default=100)
    ap.add_argument("--colors", default="auto"); ap.add_argument("--no-underlay", action="store_true")
    ap.add_argument("--out", default="design.dst"); ap.add_argument("--preview", default="preview.png")
    a = ap.parse_args()
    d, pv, info = convert(open(a.input, "rb").read(), a.width_mm, a.colors, not a.no_underlay)
    open(a.out, "wb").write(d); open(a.preview, "wb").write(pv)
    print(json.dumps(info, indent=2))
