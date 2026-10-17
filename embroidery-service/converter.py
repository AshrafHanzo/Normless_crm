"""PNG/JPG logo -> DST embroidery file.

The aim is a stitch-out that looks like the artwork: the right colours, every part of the shape
covered, edges that are crisp rather than chewed, and no thread crossing open ground.

How it works, in the order it happens:

  1. the picture is reduced to a few thread colours, one mask per colour;
  2. each mask is broken into shapes, and every shape is measured across its narrow axis;
  3. that measurement picks the stitch — a hairline gets a run, a column gets satin, a panel
     gets tatami — because the width of a shape is what decides how thread can lie on it;
  4. the shape is turned so its narrow axis is horizontal, stitched row by row, and turned back.

Step 4 is the part worth stating plainly: satin has to cross the shape, so for a vertical bar
the needle must travel left-to-right and step downwards. A digitizer that scans rows without
turning the shape first stitches *along* the bar instead, which is both ugly and unstitchable —
it was what this engine used to do.

What cannot be done is also worth stating: thread has a width. At 0.4mm a row, nothing thinner
than about 0.8mm can hold a shape, and detail below that is reported rather than faked.
"""
import os, tempfile
import cv2, numpy as np, pyembroidery as pe


SATIN_MAX_MM = 10.0     # past this a satin span snags and sags; fill it instead
MIN_SATIN_MM = 1.0      # a column thinner than this has no body: stitch its centre line instead
MIN_FEATURE_MM = 0.8    # below this, thread cannot hold a shape at all
MIN_AREA_MM2 = 0.6      # specks smaller than this are anti-alias fringe, not artwork
BORDER_MM = 1.6         # the width of a satin edge drawn around a fill
ROW_MM = 0.40           # distance between rows: the density of the fill
MAX_STITCH_MM = 3.5     # longest single stitch; past ~4mm it snags
TRAVEL_MAX_MM = 5.0     # further than this between two parts of a shape, cut the thread
PULL_MM = 0.10          # fabric pulls in under the needle; shapes are grown to meet again
THREAD_MM = 0.5         # how wide a laid thread reads, for the preview and the coverage figure
STITCH_TYPES = ("auto", "satin", "tatami", "satin_border", "run")


def convert(image_bytes: bytes, width_mm: float = 100, colors="auto", underlay: bool = True,
            row_mm: float = ROW_MM, max_stitch_mm: float = MAX_STITCH_MM, stitch_type: str = "auto"):
    """Returns (dst_bytes, preview_png_bytes, info_dict)."""
    if not 10 <= width_mm <= 400:
        raise ValueError("width_mm must be between 10 and 400")
    stitch_type = str(stitch_type or "auto").lower()
    if stitch_type not in STITCH_TYPES:
        raise ValueError(f"stitch_type must be one of: {', '.join(STITCH_TYPES)}")

    # ---- the picture -------------------------------------------------------------------------
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

    # Working at the artwork's own resolution is wasteful and, worse, uneven: a 4000px logo
    # scanned every 14px behaves differently from a 400px one scanned every 1.4px. Everything
    # below works at a fixed resolution in millimetres instead.
    px_per_mm = 12.0
    # Fine enough to find the middle of a half-millimetre stroke, which is what small lettering
    # comes down to. Past a few million pixels it only costs time and memory, so large sizes
    # step down from here.
    shape_ratio = fg.shape[0] / fg.shape[1]
    if (width_mm * px_per_mm) ** 2 * shape_ratio > 3.2e6:
        px_per_mm = max(3.5, (3.2e6 / shape_ratio) ** 0.5 / width_mm)
    tw = max(32, int(round(width_mm * px_per_mm)))
    if tw != fg.shape[1]:
        th = max(8, int(round(fg.shape[0] * tw / fg.shape[1])))
        interp = cv2.INTER_AREA if tw < fg.shape[1] else cv2.INTER_NEAREST
        bgr = cv2.resize(bgr, (tw, th), interpolation=interp)
        fg = cv2.resize(fg.astype(np.uint8), (tw, th), interpolation=cv2.INTER_NEAREST) > 0
    mm = width_mm / fg.shape[1]          # millimetres per pixel
    U = mm * 10                          # pixels -> 0.1mm, the unit a DST counts in
    row = max(1.0, row_mm / mm)          # row spacing, in pixels
    height_mm = fg.shape[0] * mm

    # ---- thread colours ----------------------------------------------------------------------
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
    # In chunks: done in one go this builds a pixels x colours x 3 scratch array, which on a
    # large design is gigabytes and gets the service killed by its memory limit.
    pick = np.empty(len(px), np.int32)
    for i in range(0, len(px), 400_000):
        part = px[i:i + 400_000]
        pick[i:i + 400_000] = ((part[:, None, :] - cent[None]) ** 2).sum(2).argmin(1)
    lbl[fg.reshape(-1)] = pick
    lbl = lbl.reshape(fg.shape)

    grow = max(1, int(round(PULL_MM / mm)) * 2 + 1)
    masks = []
    for i in range(k):
        m = (lbl == i).astype(np.uint8)
        # Close first, then open: closing seals the single-pixel seams k-means leaves along an
        # edge, opening takes off the speckle. The other order eats thin strokes.
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        # Fabric draws in under the needle, so colours are grown slightly and meet under each
        # other instead of leaving a line of cloth showing between them. Only the solid parts,
        # though: growing a half-millimetre letter stroke closes the counters of the letter and
        # a word turns into a row of blobs.
        thick = cv2.erode(m, np.ones((grow + 2, grow + 2), np.uint8))
        m = m | (cv2.dilate(m, np.ones((grow, grow), np.uint8)) &
                 cv2.dilate(thick, np.ones((grow * 2 + 1,) * 2, np.uint8)))
        if int(m.sum()) * mm * mm < MIN_AREA_MM2:
            continue
        c = cv2.cvtColor(np.uint8([[cent[i]]]), cv2.COLOR_LAB2BGR)[0, 0]
        masks.append((int(m.sum()), m, (int(c[2]) << 16) | (int(c[1]) << 8) | int(c[0])))
    masks.sort(key=lambda t: -t[0])      # the biggest area is laid first, detail on top of it
    if not masks:
        raise ValueError("Image has no artwork big enough to stitch")

    # ---- geometry ----------------------------------------------------------------------------
    def line_runs(line):
        """Where a scan row enters and leaves the shape."""
        d = np.diff(np.concatenate([[0], line.astype(np.int16), [0]]))
        return list(zip(np.where(d == 1)[0], np.where(d == -1)[0] - 1))

    def strips(m, step):
        """Scan rows, grouped into strips of rows that touch.

        Runs that overlap the row above belong to the same piece of cloth and are stitched as one
        pass. Where a shape branches the pieces are merged rather than split off — splitting is
        what used to leave single rows orphaned, and an orphaned row is a gap in the stitch-out.
        """
        groups, prev, y, h = [], [], 0.0, m.shape[0]
        while True:
            yi = int(round(y))
            if yi >= h:
                break
            cur = []
            for s, e in line_runs(m[yi]):
                hit = sorted({g for ps, pe_, g in prev if ps <= e and pe_ >= s})
                if hit:
                    g = hit[0]
                    for other in hit[1:]:
                        groups[g].extend(groups[other])
                        groups[other] = []
                        prev = [(a, b, g if c == other else c) for a, b, c in prev]
                        cur = [(a, b, g if c == other else c) for a, b, c in cur]
                else:
                    groups.append([])
                    g = len(groups) - 1
                groups[g].append((float(y), int(s), int(e)))
                cur.append((s, e, g))
            prev = cur
            y += step
        return [g for g in groups if g]

    def columns(m, step):
        """Scan rows kept as separate strokes.

        A run continues the one above it only when the two plainly carry on from each other —
        one above, one below. Where a shape branches or curls back on itself, as the ring of a
        logo does, a new stroke starts instead. That is what keeps a satin column, and the line
        of underlay beneath it, from being laid straight across the hole in the middle.
        """
        cols, prev, y, h = [], [], 0.0, m.shape[0]
        while True:
            yi = int(round(y))
            if yi >= h:
                break
            rr, cur = line_runs(m[yi]), []
            for s, e in rr:
                ov = [p for p in prev if p[0] <= e and p[1] >= s]
                c = None
                if len(ov) == 1 and sum(1 for a, b in rr if a <= ov[0][1] and b >= ov[0][0]) == 1:
                    c = ov[0][2]
                if c is None:
                    cols.append([])
                    c = len(cols) - 1
                cols[c].append((float(y), int(s), int(e)))
                cur.append((s, e, c))
            prev = cur
            y += step
        return [c for c in cols if c]

    def skeleton(m):
        """Thin a shape down to the single line running through the middle of it.

        Zhang-Suen: pixels are taken off the edges, in two alternating passes, as long as doing
        so does not break the shape apart or shorten a limb. What is left is one pixel wide and
        follows the stroke, which is the line a thin letter has to be sewn along.
        """
        img = (m > 0).astype(np.uint8)
        for _ in range(80):
            gone = False
            for step in (0, 1):
                P = np.pad(img, 1)
                p2, p3, p4 = P[:-2, 1:-1], P[:-2, 2:], P[1:-1, 2:]
                p5, p6, p7 = P[2:, 2:], P[2:, 1:-1], P[2:, :-2]
                p8, p9 = P[1:-1, :-2], P[:-2, :-2]
                ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
                neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
                crossings = sum(((ring[i] == 0) & (ring[i + 1] == 1)).astype(np.uint8) for i in range(8))
                corner = ((p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)) if step == 0 else \
                         ((p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0))
                take = (img == 1) & (neighbours >= 2) & (neighbours <= 6) & (crossings == 1) & corner
                if take.any():
                    img[take] = 0
                    gone = True
            if not gone:
                break
        return img

    def spine(m):
        """The thinned shape, walked out into lines that can be sewn one after another."""
        sk = skeleton(m)
        left = {(int(y), int(x)) for y, x in zip(*np.where(sk > 0))}
        if not left:
            return []
        whole = set(left)
        near = lambda q, pool: [(q[0] + dy, q[1] + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                                if (dy or dx) and (q[0] + dy, q[1] + dx) in pool]
        degree = {q: len(near(q, whole)) for q in whole}

        def follow(q, prev):
            """Walk away from a point, carrying straight on wherever the line forks."""
            out = []
            while True:
                step = [n for n in near(q, left)]
                if not step:
                    return out
                if prev is not None:
                    dy, dx = q[0] - prev[0], q[1] - prev[1]
                    step.sort(key=lambda n: -((n[0] - q[0]) * dy + (n[1] - q[1]) * dx))
                nxt = step[0]
                left.discard(nxt)
                out.append(nxt)
                prev, q = q, nxt

        # Ends first, so a stroke is sewn from one tip to the other rather than from its middle.
        paths = []
        for seed in sorted(whole, key=lambda q: (degree[q] != 1, q)):
            if seed not in left:
                continue
            left.discard(seed)
            # Out both ways: a seed in the middle of a stroke would otherwise leave half of it
            # behind as a separate broken piece, which is how the lettering came apart.
            ahead = follow(seed, None)
            back = follow(seed, ahead[0] if ahead else None)
            chain = back[::-1] + [seed] + ahead
            if len(chain) * mm < 0.5:
                continue                       # a whisker off the side of a stroke, not a stroke
            pts = cv2.approxPolyDP(np.array([(x, y) for y, x in chain], np.int32).reshape(-1, 1, 2),
                                   max(0.1 / mm, 0.6), False).reshape(-1, 2).astype(float)
            if len(pts) >= 2:
                paths.append(pts)
        return paths

    def to_grain(m):
        """Turn a shape so its narrow axis is horizontal, and give back the way home.

        Scan rows then cross the shape the short way, which is the direction thread has to lie
        in for satin, and the direction that keeps every stitch short enough to be sewn.
        """
        pts = cv2.findNonZero(m)
        if pts is None or len(pts) < 5:
            return m, None
        (_, _), (w, h), angle = cv2.minAreaRect(pts)
        if w > h:                       # turn the LONG side upright, so rows cross the short one
            angle += 90
        H, W = m.shape
        M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
        cos, sin = abs(M[0, 0]), abs(M[0, 1])
        nw, nh = int(H * sin + W * cos) + 2, int(H * cos + W * sin) + 2
        M[0, 2] += nw / 2 - W / 2
        M[1, 2] += nh / 2 - H / 2
        return cv2.warpAffine(m, M, (nw, nh), flags=cv2.INTER_NEAREST), cv2.invertAffineTransform(M)

    def unrotate(pts, Minv):
        if Minv is None or not pts:
            return pts
        a = np.array([[x, y, 1.0] for x, y in pts]).T
        out = Minv @ a
        return list(zip(out[0], out[1]))

    def walk(p, q, out, cap=None):
        """Stitch from p to q, breaking the move up so no single stitch is too long."""
        n = int(np.ceil(np.hypot(q[0] - p[0], q[1] - p[1]) * mm / (cap or max_stitch_mm)))
        for j in range(1, n):
            out.append((p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n))
        out.append(q)

    def inside(p, q, m):
        """Does the straight line from p to q stay on the shape?"""
        n = max(8, int(np.hypot(q[0] - p[0], q[1] - p[1]) / 2))
        t = np.linspace(0, 1, n)
        xs = np.rint(p[0] + (q[0] - p[0]) * t).astype(np.int32)
        ys = np.rint(p[1] + (q[1] - p[1]) * t).astype(np.int32)
        H, W = m.shape
        if xs.min() < 0 or ys.min() < 0 or xs.max() >= W or ys.max() >= H:
            return False
        return bool(m[ys, xs].all())

    def span(a, b, y, kind, idx, widen):
        """One row of stitching, from a to b."""
        if kind == "satin":
            if widen and abs(b - a) < widen:
                mid, half = (a + b) / 2, widen / 2
                a, b = (mid - half, mid + half) if b > a else (mid + half, mid - half)
            pts = [(a, y)]
            if abs(b - a) * mm > SATIN_MAX_MM:   # too far to cross in one go: honest coarse fill
                walk((a, y), (b, y), pts)
            else:
                pts.append((b, y))
            return pts
        n = max(1, int(np.ceil(abs(b - a) * mm / max_stitch_mm)))
        off = (idx % 3) / 3.0                    # brick the ends so they do not line up in a seam
        ts = sorted({0.0, 1.0, *[min(1.0, (j + off) / n) for j in range(1, n)]})
        return [(a + (b - a) * t, y) for t in ts]

    def fill(strip, part, kind, widen=0.0):
        """One strip, stitched row by row, as a set of unbroken paths.

        Nothing is dropped: a strip one row high is still a row of the artwork. The needle only
        travels between two rows when the line between them stays on the shape, so no thread is
        ever dragged across open cloth.
        """
        rows, out, cur, last = {}, [], [], None
        for y, s, e in strip:
            rows.setdefault(y, []).append((s, e))
        ys = sorted(rows)
        # Where each row of a satin column starts and ends comes off a bitmap, so it wanders by
        # a pixel either way and the edge of a letter comes out scalloped. Averaging each edge
        # over its neighbours puts the line back without moving it.
        if kind == "satin" and len(ys) >= 5 and all(len(rows[y]) == 1 for y in ys):
            k = 3
            smooth = lambda v: np.convolve(np.pad(np.asarray(v, float), k // 2, mode="edge"),
                                           np.ones(k) / k, "valid")
            a = smooth([rows[y][0][0] for y in ys])
            b = smooth([rows[y][0][1] for y in ys])
            rows = {y: [(a[i], b[i])] for i, y in enumerate(ys)}
        for i, y in enumerate(ys):
            rev = i % 2 == 1
            for s, e in sorted(rows[y], key=lambda t: t[0], reverse=rev):
                a, b = (e, s) if rev else (s, e)
                pts = span(a, b, y, kind, i, widen)
                if last is not None and np.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) * mm <= TRAVEL_MAX_MM \
                        and inside(last, pts[0], part):
                    walk(last, pts[0], cur)
                elif cur:
                    out.append(cur)
                    cur = []
                cur.extend(pts)
                last = pts[-1]
        if cur:
            out.append(cur)
        return [p for p in out if len(p) >= 2]

    def centre_line(col, part, every=1):
        """The middle of a stroke, followed down it.

        Used twice: as the whole stitch for a hairline too thin to hold a satin column, and as
        the underlay that holds a satin column in place. Either way the line is broken wherever
        the next point cannot be reached across the shape itself.
        """
        out, cur, last = [], [], None
        for y, s, e in col[::max(1, every)]:
            q = ((s + e) / 2.0, y)
            if last is not None and np.hypot(q[0] - last[0], q[1] - last[1]) * mm <= TRAVEL_MAX_MM \
                    and inside(last, q, part):
                walk(last, q, cur)
            else:
                if len(cur) >= 2:
                    out.append(cur)
                cur = [q]
            last = q
        if len(cur) >= 2:
            out.append(cur)
        return out

    def contours(m, inset_px=0.0):
        src = cv2.erode(m, np.ones((int(inset_px) * 2 + 1,) * 2, np.uint8)) if inset_px >= 1 else m
        cs, _ = cv2.findContours(src, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        paths = []
        for c in cs:
            if cv2.contourArea(c) * mm * mm < MIN_AREA_MM2:
                continue
            c = cv2.approxPolyDP(c, max(0.25 / mm, 0.5), True).reshape(-1, 2).astype(float)
            if len(c) >= 3:
                paths.append(c)
        return paths

    def run_path(path, cap=None):
        pts = [tuple(path[0])]
        for q in list(path[1:]) + [path[0]]:
            walk(pts[-1], tuple(q), pts, cap)
        return pts

    def satin_border(path):
        """A satin edge: the needle swinging either side of the line as it travels it."""
        half = (BORDER_MM / 2) / mm
        step = max(1, int(round(row_mm / mm)))
        pts, n = [], len(path)
        for i in range(0, n + 1, step):
            p, nxt = path[i % n], path[(i + step) % n]
            dx, dy = nxt[0] - p[0], nxt[1] - p[1]
            L = np.hypot(dx, dy) or 1.0
            ox, oy = -dy / L * half, dx / L * half
            side = 1 if (i // step) % 2 == 0 else -1
            pts.append((p[0] + ox * side, p[1] + oy * side))
            pts.append((p[0] - ox * side, p[1] - oy * side))
        return pts

    def zigzag(strip, part):
        """Sparse underlay: it holds the cloth still so the top stitching lands where it should."""
        rows = sorted({y for y, _, _ in strip})
        keep = rows[::max(1, int(round(2.0 / row_mm)))]
        by = {}
        for y, s, e in strip:
            by.setdefault(y, []).append((s, e))
        ins, pts = 0.5 / mm, []
        for i, y in enumerate(keep):
            s, e = max(by[y], key=lambda t: t[1] - t[0])
            if (e - s) * mm < 1.4:
                continue
            q = (s + ins if i % 2 == 0 else e - ins, y)
            if pts and not inside(pts[-1], q, part):
                break
            walk(pts[-1], q, pts) if pts else pts.append(q)
        return [pts] if len(pts) >= 2 else []

    # ---- what each shape gets ------------------------------------------------------------------
    used, laid = set(), set()
    too_wide = 0
    curved = 0
    hairlines = []      # how wide each stroke was that could not hold a satin column
    dropped = 0

    def jobs_for(m):
        """Break one colour into shapes and give each the stitch its width can carry."""
        nonlocal too_wide, curved, hairlines, dropped
        shapes = []
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        for ci in range(1, n):
            if stats[ci, cv2.CC_STAT_AREA] * mm * mm < MIN_AREA_MM2:
                dropped += 1
                continue
            # Each shape is worked on inside its own box rather than across the whole picture.
            # A letter is a few thousand pixels in a design of several million, and measuring,
            # turning and thinning it at full size is most of what the converter used to spend
            # its time on.
            pad = 3
            x0 = max(0, stats[ci, cv2.CC_STAT_LEFT] - pad)
            y0 = max(0, stats[ci, cv2.CC_STAT_TOP] - pad)
            x1 = min(m.shape[1], stats[ci, cv2.CC_STAT_LEFT] + stats[ci, cv2.CC_STAT_WIDTH] + pad)
            y1 = min(m.shape[0], stats[ci, cv2.CC_STAT_TOP] + stats[ci, cv2.CC_STAT_HEIGHT] + pad)
            part = (labels[y0:y1, x0:x1] == ci).astype(np.uint8)
            jobs = []

            def done():
                """Put this shape's work back where it belongs on the design."""
                shapes.append([(t, k, [(x + x0, y + y0) for x, y in pts])
                               for t, k, pts in jobs if len(pts) >= 2])

            # The widest the shape ever gets, measured from the inside out. This is the number
            # that decides everything: thread can only lie the way a shape has room for.
            wide_mm = float(cv2.distanceTransform(part, cv2.DIST_L2, 3).max()) * 2 * mm

            if stitch_type == "run":
                for path in contours(part):
                    jobs.append((1, "run", run_path(path)))
                done()
                continue

            if wide_mm < MIN_SATIN_MM and stitch_type in ("auto", "satin", "satin_border"):
                # One line of thread down the middle of it. Going round its outline instead lays
                # two lines half a millimetre apart, and at that spacing the thread closes up the
                # inside of the letter: GLOBAL came out as GI OHAI.
                hairlines.append(wide_mm)
                for path in spine(part):
                    pts = [tuple(path[0])]
                    for q in path[1:]:
                        walk(pts[-1], tuple(q), pts, cap=1.2)
                    jobs.append((1, "run", pts))
                done()
                continue

            wants_satin = stitch_type in ("satin", "auto")
            if wants_satin and wide_mm <= SATIN_MAX_MM:
                rot, Minv = to_grain(part)
                cols = columns(rot, row)
                spans = [e - s for col in cols for _, s, e in col]
                # A shape is only satin-able if the rows really do cross it the short way. On a
                # ring or a curl they do not: the scan cuts the bend at an angle and the spans
                # run long. Rather than lay a stitch nobody can sew, such a shape is filled.
                over = sum(1 for w in spans if w * mm > SATIN_MAX_MM) / max(1, len(spans))
                if over <= 0.12:
                    widen = min(MIN_SATIN_MM, wide_mm) / mm
                    for col in cols:
                        if underlay:
                            for pts in centre_line(col, rot, every=int(round(1.5 / row_mm))):
                                laid.add("centre run")
                                jobs.append((0, "satin", unrotate(pts, Minv)))
                        for pts in fill(col, rot, "satin", widen):
                            jobs.append((1, "satin", unrotate(pts, Minv)))
                    done()
                    continue
                curved += 1
            elif wants_satin:
                too_wide += 1

            # A panel: tatami, with an edge run to sharpen the outline the fill leaves ragged.
            for strip in strips(part, row):
                if underlay:
                    for pts in zigzag(strip, part):
                        laid.add("zigzag")
                        jobs.append((0, "tatami", pts))
                for pts in fill(strip, part, "tatami"):
                    jobs.append((1, "tatami", pts))
            for path in contours(part, inset_px=max(1.0, (THREAD_MM / 2) / mm)):
                jobs.append((2, "edge run", run_path(path)))
            if stitch_type == "satin_border":
                for path in contours(part):
                    jobs.append((2, "satin border", satin_border(path)))
            done()
        return shapes

    # ---- the pattern ---------------------------------------------------------------------------
    pat = pe.EmbPattern()
    cur = None
    for ci, (_, m, col) in enumerate(masks):
        pat.add_thread(pe.EmbThread(col))
        shapes = [g for g in jobs_for(m) if g]
        # The mask a hair wider, for deciding whether the needle may travel. A stitch that ends
        # on the edge of a shape lands a rounded pixel outside it, and testing against the mask
        # itself cut the thread to move half a millimetre — 142 times in one small logo.
        edge = max(3, int(round(0.3 / mm)) * 2 + 1)
        travel_m = cv2.dilate(m, np.ones((edge, edge), np.uint8))

        def nearest(pool, pick):
            """The piece of work whose nearer end is closest to where the needle is now."""
            if cur is None:
                return pool[0], False
            def reach(i):
                pts = pick(i)
                a, b = pts[0], pts[-1]
                da = (a[0] - cur[0]) ** 2 + (a[1] - cur[1]) ** 2
                db = (b[0] - cur[0]) ** 2 + (b[1] - cur[1]) ** 2
                return (db, True) if db < da else (da, False)
            i = min(pool, key=lambda i: reach(i)[0])
            return i, reach(i)[1]

        # Where each shape starts and ends, worked out once. Rebuilding this list for every
        # candidate on every pick is what made a large design take minutes rather than seconds.
        anchors = [[g[0][2][0], g[-1][2][-1]] for g in shapes]
        waiting = list(range(len(shapes)))
        while waiting:
            # One shape is finished before the next is started: that is how a machinist works,
            # and it keeps the thread from crossing the design twice.
            gi, _ = nearest(waiting, lambda i: anchors[i])
            waiting.remove(gi)
            jobs = shapes[gi]
            # Within the shape: the underlay first, then the fill it holds down, then the edge
            # run that sharpens what the fill left ragged — and inside each of those, in bands
            # across the shape, turning at the end of each band. Hunting for the nearest piece
            # of work every time instead is the same answer and quadratic to arrive at, which on
            # a big design cost minutes.
            band = max(1.0, 5.0 / mm)
            def order(i):
                tier, _, pts = jobs[i]
                x, y = pts[0]
                b = int(y // band)
                return (tier, b, x if b % 2 == 0 else -x)
            def sequence():
                """The order this shape's pieces are sewn in.

                A letter is a handful of pieces: look each time for the nearest, which keeps the
                thread unbroken. A filled panel is thousands, and looking each time is quadratic,
                so those are sewn in bands instead — the same answer, arrived at in a moment.
                """
                if len(jobs) <= 120:
                    rest = list(range(len(jobs)))
                    while rest:
                        tier = min(jobs[i][0] for i in rest)
                        pool = [i for i in rest if jobs[i][0] == tier]
                        i, _ = nearest(pool, lambda j: jobs[j][2])
                        rest.remove(i)
                        yield i
                else:
                    yield from sorted(range(len(jobs)), key=order)

            for idx in sequence():
                _, kind, pts = jobs[idx]
                a, z = pts[0], pts[-1]
                flip = cur is not None and \
                    (z[0] - cur[0]) ** 2 + (z[1] - cur[1]) ** 2 < (a[0] - cur[0]) ** 2 + (a[1] - cur[1]) ** 2
                # A line of stitching reads the same sewn either way round, so it is entered
                # from whichever end the needle is near — less travel, and fewer thread cuts.
                if flip:
                    pts = pts[::-1]
                used.add(kind)
                start = pts[0]
                if cur is not None:
                    gap_mm = np.hypot(start[0] - cur[0], start[1] - cur[1]) * mm
                    # Travelling is only allowed under the shape itself. Anything else is thread
                    # lying across bare cloth, which is what made the old files look like cobwebs.
                    # Under a stitch length the move hides beneath the stitching either side
                    # of it, so it is never worth a cut.
                    if gap_mm <= 1.2 or (gap_mm <= TRAVEL_MAX_MM and inside(cur, start, travel_m)):
                        hop = []
                        walk(cur, start, hop)
                        for x, y in hop[:-1]:
                            pat.add_stitch_absolute(pe.STITCH, x * U, y * U)
                    else:
                        pat.add_command(pe.TRIM)
                        pat.add_stitch_absolute(pe.JUMP, start[0] * U, start[1] * U)
                for x, y in pts:
                    pat.add_stitch_absolute(pe.STITCH, x * U, y * U)
                cur = pts[-1]
        pat.add_command(pe.TRIM)
        if ci < len(masks) - 1:
            pat.add_command(pe.COLOR_CHANGE)
            cur = None
    pat.add_command(pe.END)

    # ---- the file, and a preview of what it will look like sewn --------------------------------
    with tempfile.TemporaryDirectory() as td:
        dst_path = os.path.join(td, "d.dst")
        pe.write_dst(pat.get_normalized_pattern(), dst_path,
                     {"long_stitch_contingency": pe.CONTINGENCY_LONG_STITCH_SEW_TO,
                      "max_stitch": 121, "max_jump": 121})
        out = pe.read(dst_path)
        dst_bytes = open(dst_path, "rb").read()

    png_bytes, covered, spill, stitches, longest = _render(out, [c for _, _, c in masks],
                                                           fg, width_mm, height_mm)

    # ---- what the person at the machine needs to be told ---------------------------------------
    # How wide the stroke each pixel belongs to is — not how far that pixel is from an edge.
    # Distance to the edge alone calls the rim of every shape thin, which made the old figure
    # say half a solid logo was too fine to stitch.
    dist = cv2.distanceTransform(fg.astype(np.uint8), cv2.DIST_L2, 5)
    reach = max(3, int(round(1.0 / mm)) * 2 + 1)
    stroke = cv2.dilate(dist, np.ones((reach, reach), np.uint8)) * mm * 2
    thin_share = float((stroke[fg] < MIN_FEATURE_MM).mean())
    # Worked out from the strokes that actually failed: the size at which the middle one of them
    # would be wide enough to hold a satin column.
    need = min(400, int(np.ceil(width_mm * MIN_SATIN_MM / max(0.05, float(np.median(hairlines)))))) if hairlines else 0
    bigger = f" At about {need}mm they would hold properly." if need > width_mm * 1.1 else ""
    warnings = []
    if thin_share > 0.15:
        warnings.append(
            f"{thin_share*100:.0f}% of this artwork is finer than {MIN_FEATURE_MM}mm at {width_mm:.0f}mm wide — "
            "thread cannot hold detail that fine, and simplifying the artwork is the surest way out.")
    if hairlines:
        n = len(hairlines)
        warnings.append(
            f"{n} stroke{'s were' if n > 1 else ' was'} too thin for a satin column and "
            f"stitched as a single line of thread.{bigger}")
    if curved:
        warnings.append(
            f"{curved} shape{'s curve' if curved > 1 else ' curves'} too much for a satin column "
            "and {0} filled instead.".format('were' if curved > 1 else 'was'))
    if too_wide:
        warnings.append(
            f"{too_wide} shape{'s are' if too_wide > 1 else ' is'} wider than {SATIN_MAX_MM:.0f}mm — "
            "filled with tatami instead, because a satin span that long snags and sags.")
    if covered < 93:
        warnings.append(f"Only {covered:.0f}% of the artwork is covered by thread — check the preview before stitching.")
    if dropped:
        warnings.append(f"{dropped} speck{'s' if dropped > 1 else ''} under {MIN_AREA_MM2}mm² dropped as too small to sew.")
    if width_mm < 60:
        warnings.append("Small size: fine lines and small text may stitch rough.")

    info = {
        "width_mm": round(width_mm, 1),
        "height_mm": round(height_mm, 1),
        "stitch_count": stitches,
        "thread_colors": [f"#{c:06X}" for _, _, c in masks],   # in sewing order
        "stitch_type": stitch_type,
        # What came out, rather than what was asked for: the two differ whenever a shape was too
        # wide for satin or too thin for anything, and the machinist should see which.
        "fill": " + ".join(sorted(used)) or "none",
        "underlay": " + ".join(sorted(laid)) or "none",
        "coverage_pct": round(covered, 1),
        "longest_stitch_mm": round(longest, 1),
        "warnings": warnings,
    }
    return dst_bytes, png_bytes, info


def _render(pattern, colours, fg, width_mm, height_mm):
    """Draw the finished file as thread, and measure it against the artwork.

    Every stitch is drawn at the width thread actually covers, in sewing order, so a colour laid
    later sits on top of one laid earlier — which is what the machine does. The same drawing is
    then compared with the artwork's own silhouette to say how much of it the thread reaches.
    """
    ppm = min(14.0, 1800.0 / max(width_mm, height_mm))
    W, H = int(width_mm * ppm) + 16, int(height_mm * ppm) + 16
    canvas = np.full((H, W, 3), 255, np.uint8)
    cov = np.zeros((H, W), np.uint8)
    pen = max(1, int(round(THREAD_MM * ppm)))

    xs = [s[0] for s in pattern.stitches] or [0]
    ys = [s[1] for s in pattern.stitches] or [0]
    minx, miny = min(xs), min(ys)
    place = lambda s: (int((s[0] - minx) / 10 * ppm) + 8, int((s[1] - miny) / 10 * ppm) + 8)

    ci, prev, stitches, longest, last = 0, None, 0, 0.0, None
    for s in pattern.stitches:
        cmd = s[2] & 0xFF
        if cmd == pe.STITCH:
            q = place(s)
            if prev is not None:
                c = colours[min(ci, len(colours) - 1)]
                bgr = (c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF)
                cv2.line(canvas, prev, q, bgr, pen, cv2.LINE_AA)
                cv2.line(cov, prev, q, 255, pen, cv2.LINE_AA)
                longest = max(longest, float(np.hypot(s[0] - last[0], s[1] - last[1]) / 10))
            prev, last, stitches = q, s, stitches + 1
        elif cmd == pe.JUMP:
            # The needle is up: a jump moves the frame and lays nothing, so the drawing has to
            # lift its pen too, or the preview shows thread where the cloth is bare.
            prev, last = None, s
        elif cmd == pe.TRIM:
            prev = None
        elif cmd == pe.COLOR_CHANGE:
            ci, prev = ci + 1, None

    target = cv2.resize(fg.astype(np.uint8), (W - 16, H - 16), interpolation=cv2.INTER_NEAREST)
    T = np.zeros((H, W), bool)
    T[8:H - 8, 8:W - 8] = target > 0
    want = max(1, int(T.sum()))
    covered = float(((cov > 60) & T).sum()) / want * 100
    spill = float(((cov > 60) & ~T).sum()) / want * 100
    ok, buf = cv2.imencode(".png", canvas)
    return (buf.tobytes() if ok else b""), covered, spill, stitches, longest


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
