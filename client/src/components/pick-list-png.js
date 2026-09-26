/**
 * The pick list as an image.
 *
 * Drawn on a canvas rather than fetched from the server: the whole reason anyone wants a PNG is
 * to paste it into WhatsApp, and this needs no image library on the server and no screenshot of a
 * browser. The layout mirrors the PDF — a banded table per garment type, the edition named once
 * above its own colours and sizes — so the printed sheet and the one on someone's phone are the
 * same document.
 *
 * Everything is measured in CSS pixels and drawn at 2×, so it stays sharp when someone pinches
 * into it.
 */

const S = 2;                    // draw at 2×, present at 1×
const W = 980;                  // wide enough for a long edition name and a row of order numbers
const PAD = 30;
const INK = '#15161a';
const MUTED = '#6b7280';
const RULE = '#e4e6eb';
const BAND = '#f3f4f6';
const ZEBRA = '#fafafa';

const FONT = (size, weight = '400') =>
  `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

// Edition · Colour · Size · Qty · Orders, matching the PDF's proportions.
const COL = { edition: PAD + 12, colour: PAD + 330, size: PAD + 500, qty: PAD + 588, orders: PAD + 652 };
const WID = { edition: 300, colour: 160, size: 80, qty: 34, orders: W - PAD - COL.orders - 12 };

/** Break text into lines that fit a width, measured with the font actually being drawn. */
function wrap(c, text, width, font) {
  c.font = font;
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const next = `${line}  ${word}`;
    if (c.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
  }
  lines.push(line);
  return lines;
}

export default function drawPickList(data, span) {
  const rows = data.rows || [];
  const byType = [];
  for (const r of rows) {
    const last = byType[byType.length - 1];
    if (last && last.type === r.type) last.rows.push(r);
    else byType.push({ type: r.type, rows: [r] });
  }

  // Generous first pass; the canvas is cropped to what was used at the end, because an image with
  // a foot of white under it looks like something failed to load.
  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = (400 + rows.length * 60 + byType.length * 110) * S;
  const c = canvas.getContext('2d');
  c.scale(S, S);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, W, canvas.height);

  const text = (s, x, y, { size = 12, weight = '400', color = INK, align = 'left', width } = {}) => {
    c.font = FONT(size, weight);
    c.fillStyle = color;
    c.textAlign = align;
    c.fillText(String(s), align === 'right' ? x + (width || 0) : x, y, width || undefined);
    c.textAlign = 'left';
  };
  const box = (x, y, w, h, fill) => { c.fillStyle = fill; c.fillRect(x, y, w, h); };
  const rule = (y, color = RULE) => {
    c.strokeStyle = color; c.lineWidth = 1;
    c.beginPath(); c.moveTo(PAD, y + 0.5); c.lineTo(W - PAD, y + 0.5); c.stroke();
  };

  /* ── Masthead ─────────────────────────────────────────────────────────────────────── */
  let y = PAD + 26;
  text('Pick list', PAD, y, { size: 26, weight: '700' });
  text(span, PAD, y + 22, { size: 13, color: MUTED });
  text('Unfulfilled orders only — held, cancelled and refunded orders are left out.', PAD, y + 41, { size: 11, color: MUTED });

  const stat = (label, value, right) => {
    text(value, right - 70, y, { size: 21, weight: '700', align: 'right', width: 70 });
    text(label.toUpperCase(), right - 70, y + 18, { size: 9.5, color: MUTED, align: 'right', width: 70 });
  };
  stat('units', data.summary.units, W - PAD - 160);
  stat('lines', data.summary.lines, W - PAD - 80);
  stat('orders', data.summary.orders, W - PAD);

  y += 58;
  c.strokeStyle = INK; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(PAD, y); c.lineTo(W - PAD, y); c.stroke();
  y += 24;

  /* ── A table per garment type ─────────────────────────────────────────────────────── */
  for (const section of byType) {
    const units = section.rows.reduce((n, r) => n + r.qty, 0);
    const lines = section.rows.length;

    box(PAD, y, W - PAD * 2, 30, INK);
    text(section.type, PAD + 12, y + 20, { size: 14, weight: '700', color: '#ffffff' });
    text(`${units} unit${units === 1 ? '' : 's'} · ${lines} line${lines === 1 ? '' : 's'}`,
      W - PAD - 212, y + 20, { size: 11.5, color: '#d7d9de', align: 'right', width: 200 });
    y += 30;

    box(PAD, y, W - PAD * 2, 22, BAND);
    const head = (label, x, opts) => text(label, x, y + 15, { size: 9.5, weight: '700', color: MUTED, ...opts });
    head('EDITION', COL.edition); head('COLOUR', COL.colour); head('SIZE', COL.size);
    head('QTY', COL.qty, { align: 'right', width: WID.qty }); head('ORDERS', COL.orders);
    y += 22;

    let edition = null, stripe = 0;
    for (const r of section.rows) {
      const orderLines = wrap(c, r.orders.join('  '), WID.orders, FONT(10));
      const rowH = Math.max(orderLines.length * 15 + 8, 26);

      // The band alternates per EDITION, not per row: an edition with four sizes should read as
      // one block, which striping row by row breaks apart.
      const fresh = r.edition !== edition;
      if (fresh) stripe++;
      if (stripe % 2 === 0) box(PAD, y, W - PAD * 2, rowH, ZEBRA);
      if (fresh && stripe > 1) rule(y);

      const base = y + 17;
      if (fresh) { text(r.edition, COL.edition, base, { size: 12, weight: '700', width: WID.edition }); edition = r.edition; }
      text(r.color, COL.colour, base, { size: 12, width: WID.colour });
      text(r.size, COL.size, base, { size: 12, width: WID.size });
      text(r.qty, COL.qty, base, { size: 13, weight: '700', align: 'right', width: WID.qty });
      orderLines.forEach((line, i) => text(line, COL.orders, y + 16 + i * 15, { size: 10, color: MUTED }));
      y += rowH;
    }
    rule(y);
    y += 30;
  }

  if (!rows.length) { text('Nothing waiting to go out in this period.', PAD, y + 8, { size: 13, color: MUTED }); y += 34; }

  text(`Normless CRM · generated ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    PAD, y + 6, { size: 10, color: MUTED });
  y += 20;

  /* ── Crop to what was drawn ───────────────────────────────────────────────────────── */
  const out = document.createElement('canvas');
  out.width = W * S;
  out.height = Math.round((y + PAD - 10) * S);
  const oc = out.getContext('2d');
  oc.fillStyle = '#ffffff';
  oc.fillRect(0, 0, out.width, out.height);
  oc.drawImage(canvas, 0, 0);
  return out;
}
