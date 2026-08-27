const fs = require('fs');
const path = require('path');

const SELLER = {
  legalName: 'Normless',
  brandName: 'CREWFIT',
  tagline: 'A brand of Normless',
  address: 'Plot no 2, Dhanalakshmi Nagar, Moulivakkam, Iyyappanthangal, Chennai, Tamil Nadu 600125',
  gstin: '33AAYFN3674M1ZF',
  stateCode: '33',
  state: 'Tamil Nadu',
  returnPhone: '8754604214', // printed on shipping labels so couriers can call on a failed delivery
};
// PDFs print on white paper, so the dark lockup is the legible one — cf_white would vanish.
// Still guarded by existsSync: a missing file degrades to a text-only header rather than throwing.
const LOGO_PATH = path.join(__dirname, '..', '..', 'client', 'logo', 'cf_logo', 'cf_black.png');
// Where the advance is paid. Printed on the quotation so the customer never has to ask for it,
// which is most of what delays an order actually starting.
const BANK = [
  ['Account Holder', 'NORMLESS'],
  ['Account Number', '50200112100799'],
  ['IFSC Code', 'HDFC0005281'],
  ['Branch', 'MOULIVAKKAM'],
  ['Account Type', 'Current Account'],
  ['GSTIN', '33AAYFN3674M1ZF'],
];
// Cotton knit T-shirts/polos — verify this matches your actual product mix before relying on it for filing.
const HSN_CODE = '6109';

// One accent, used for every heading, rule and table head on the quotation.
const BLUE = '#1F6FB2';
const INK = '#1a1a1a';
const MUTED = '#666';

const QUOTE_VALID_DAYS = 7;
const ADVANCE_PCT = 50;

/**
 * 'YYYY-MM-DD' is parsed as UTC by the Date constructor, so west of Greenwich it renders as the
 * day before. A calendar date has no timezone — read the parts and build a local date from them.
 */
const asDate = (d) => {
  if (d instanceof Date) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '').slice(0, 10));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
};
const longDate = (d) => asDate(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const fullDate = (d) => asDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const money = (n) => `Rs. ${(Number(n) || 0).toLocaleString('en-IN')}`;

function fyLabel(d) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts in April
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

async function nextInvoiceNumber(db) {
  const r = await db.query("SELECT nextval('crewfit_invoice_seq') AS n");
  return `CREWFIT/${fyLabel(new Date())}/${String(r.rows[0].n).padStart(4, '0')}`;
}

/**
 * Proformas run on their own sequence. An advance on goods carries no GST liability
 * (Notification 66/2017 — tax falls due at supply), so acknowledging one must never consume a
 * tax invoice number: that number belongs to the supply, which has not happened yet.
 */
async function nextProformaNumber(db) {
  const r = await db.query("SELECT nextval('crewfit_proforma_seq') AS n");
  return `PRO/${fyLabel(new Date())}/${String(r.rows[0].n).padStart(4, '0')}`;
}

/**
 * Which tax heads apply. Place of supply decides it — the buyer's GSTIN is only available for
 * registered customers, and an out-of-state consumer sale is still IGST.
 */
function taxSplit(order) {
  const byGstin = (order.gst_number || '').slice(0, 2);
  if (byGstin) return { interState: byGstin !== SELLER.stateCode };
  const pos = (order.place_of_supply || '').trim().toLowerCase();
  return { interState: !!pos && pos !== SELLER.state.toLowerCase() };
}

/** Shared letterhead + seller/buyer block. Returns the y to carry on from. */
function documentHeader(doc, order, { title, number, date, numberLabel }) {
  let headerX = 40;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 40, 34, { width: 58 });
    headerX = 108;
  }
  doc.fontSize(20).fillColor('#1a1a1a').text(SELLER.brandName, headerX, 44);
  doc.fontSize(9).fillColor('#666').text(SELLER.tagline, headerX, 68);

  doc.fontSize(15).fillColor('#1a1a1a').text(title, 300, 44, { width: 255, align: 'right' });
  doc.fontSize(9).fillColor('#444')
    .text(`${numberLabel}: ${number}`, 300, 68, { width: 255, align: 'right' })
    .text(`Date: ${date}`, 300, 82, { width: 255, align: 'right' })
    .text(`Order Ref: CF-${order.sl_no}`, 300, 96, { width: 255, align: 'right' });

  doc.moveTo(40, 120).lineTo(555, 120).strokeColor('#ddd').stroke();

  doc.fontSize(9).fillColor('#888').text('SOLD BY', 40, 132);
  doc.fontSize(10).fillColor('#1a1a1a').text(`${SELLER.legalName} (${SELLER.brandName})`, 40, 146);
  doc.fontSize(9).fillColor('#444').text(SELLER.address, 40, 160, { width: 250 });
  doc.text(`GSTIN: ${SELLER.gstin}`, 40, 202);
  doc.text(`State: ${SELLER.state} (${SELLER.stateCode})`, 40, 215);

  doc.fontSize(9).fillColor('#888').text('BILLED TO', 320, 132);
  doc.fontSize(10).fillColor('#1a1a1a').text(order.billing_name || order.customer_name || '-', 320, 146);
  doc.fontSize(9).fillColor('#444');
  let by = 160;
  if (order.contact_person) { doc.text(order.contact_person, 320, by, { width: 235 }); by += 13; }
  doc.text(order.billing_address || order.delivery_location || '-', 320, by, { width: 235 });
  by += 28;
  doc.text(`GSTIN: ${order.gst_number || 'Unregistered'}`, 320, by); by += 13;
  doc.text(`Place of Supply: ${order.place_of_supply || SELLER.state}`, 320, by); by += 13;
  doc.text(`Phone: ${order.billing_mobile || order.contact_number || '-'}`, 320, by);

  return 250;
}

/** The line-item table. Returns the y below it. */
function itemsTable(doc, order, y) {
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#ddd').stroke();
  y += 8;
  doc.fontSize(9).fillColor('#888');
  doc.text('#', 40, y, { width: 20 });
  doc.text('Description', 65, y, { width: 190 });
  doc.text('HSN', 260, y, { width: 50 });
  doc.text('Qty', 315, y, { width: 40, align: 'right' });
  doc.text('Rate', 360, y, { width: 60, align: 'right' });
  doc.text('Amount', 460, y, { width: 95, align: 'right' });
  y += 14;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#ddd').stroke();
  y += 8;

  const items = Array.isArray(order.line_items) && order.line_items.length
    ? order.line_items
    : [{ product: order.product, color: order.color, qty: order.qty, unit_price: order.unit_price, product_total: order.product_total }];

  doc.fontSize(9).fillColor('#1a1a1a');
  items.forEach((it, i) => {
    doc.text(String(i + 1), 40, y, { width: 20 });
    doc.text(`${it.product || '-'}${it.color ? ` (${it.color})` : ''}`, 65, y, { width: 190 });
    doc.text(it.hsn || HSN_CODE, 260, y, { width: 50 });
    doc.text(String(it.qty || 0), 315, y, { width: 40, align: 'right' });
    doc.text(money(it.unit_price), 360, y, { width: 60, align: 'right' });
    doc.text(money(it.product_total), 460, y, { width: 95, align: 'right' });
    y += 16;
  });
  if (order.shipping) {
    doc.text('Shipping & Handling', 65, y, { width: 190 });
    doc.text(money(order.shipping), 460, y, { width: 95, align: 'right' });
    y += 16;
  }
  y += 4;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#ddd').stroke();
  return y + 10;
}

/** Right-aligned label/value totals block. */
function totalsBlock(doc, y) {
  const rightX = 340;
  return {
    row(label, val, bold) {
      doc.fontSize(9).fillColor(bold ? '#1a1a1a' : '#444').font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(label, rightX, y, { width: 120 })
        .text(val, rightX + 120, y, { width: 95, align: 'right' });
      y += 15;
    },
    note(text) {
      doc.font('Helvetica').fontSize(8).fillColor('#888').text(text, rightX, y, { width: 215, align: 'right' });
      y += 12;
    },
    get y() { return y; },
  };
}

/**
 * Proforma invoice for an advance. Deliberately not a tax invoice: it declares no GST, quotes no
 * tax heads as payable, and says so in as many words — a customer who treats it as one would be
 * claiming input credit on goods they have not received yet (Sec 16(2)(b)).
 */
function renderProforma(doc, order, proforma) {
  let y = documentHeader(doc, order, {
    title: 'PROFORMA INVOICE', numberLabel: 'Proforma No', number: proforma.number, date: proforma.date,
  });
  y = itemsTable(doc, order, y);

  const t = totalsBlock(doc, y);
  t.row('Order Value (incl. GST)', money(order.grand_total));
  t.row('Advance Received', money(proforma.amount), true);
  t.row('Balance Due', money((Number(order.grand_total) || 0) - (Number(proforma.amount) || 0)));

  doc.font('Helvetica').fontSize(8).fillColor('#666').text(
    'This is a proforma invoice acknowledging an advance payment. It is NOT a tax invoice and no GST is '
    + 'charged on it, so no input tax credit may be claimed against it. A tax invoice for the full order '
    + 'value will be issued once the balance is settled and the goods are supplied.',
    40, Math.max(t.y + 14, 700), { width: 515 });

  doc.fontSize(8).fillColor('#999')
    .text('This is a computer-generated document and does not require a physical signature.', 40, 780, { width: 515, align: 'center' });
}

/**
 * The tax invoice: one per order, for the full order value, issued when the balance is settled.
 * `invoice` carries the full-value figures; `proforma` is the advance document it supersedes, if
 * there was one, referenced so the customer can tie the two together.
 */
function renderInvoice(doc, order, invoice, proforma) {
  const { interState } = taxSplit(order);
  let y = documentHeader(doc, order, {
    title: 'TAX INVOICE', numberLabel: 'Invoice No', number: invoice.number, date: invoice.date,
  });
  y = itemsTable(doc, order, y);

  const t = totalsBlock(doc, y);
  t.row('Taxable Value', money(invoice.taxable_value));
  if (interState) {
    t.row(`IGST @ ${invoice.gst_pct}%`, money(invoice.gst_amount));
  } else {
    t.row(`CGST @ ${(invoice.gst_pct / 2).toFixed(1)}%`, money(invoice.gst_amount / 2));
    t.row(`SGST @ ${(invoice.gst_pct / 2).toFixed(1)}%`, money(invoice.gst_amount / 2));
  }
  t.row('Invoice Total', money(invoice.amount), true);
  if (proforma) t.note(`Advance received against proforma ${proforma.number}`);
  t.note('Amount Paid in Full — no balance outstanding');

  // A paid-in-full stamp, angled across the totals so it reads as a status rather than a line item.
  doc.save();
  doc.rotate(-14, { origin: [130, t.y + 20] })
    .fontSize(30).font('Helvetica-Bold').fillColor('#16a34a').opacity(0.16)
    .text('PAID', 60, t.y, { width: 200, align: 'center' });
  doc.restore();
  doc.opacity(1).font('Helvetica');

  doc.fontSize(8).fillColor('#999')
    .text('This is a computer-generated invoice and does not require a physical signature.', 40, 780, { width: 515, align: 'center' });
}

// The fabric a line was priced against — "240 GSM · 100% Combed Cotton Airtex (Bio Washed)" —
// so the customer can tell two similar-looking quotes apart. Either half may be missing on
// quotes raised before these were recorded.
function fabricSpec(it) {
  return [it.gsm ? `${it.gsm} GSM` : null, it.material].filter(Boolean).join(' · ');
}

/** What is being printed and where, when the quote says. Both are optional free text. */
function printingSpec(it) {
  return [it.printing_placement, it.printing_type].filter(Boolean).join(' · ');
}

// Quotations aren't tax documents — no sequence number, no GSTIN requirement — just a clean,
// shareable price breakdown for a Crewfit quote.
/**
 * The quotation a customer actually receives.
 *
 * Laid out to the house template: logo and title across the top, the buyer and delivery in one
 * band, priced lines, then the two things that decide whether an order starts — what is payable
 * now, and where to pay it. Every buyer field is optional; a blank one is left out rather than
 * printed as an empty label, so a quote raised before the paperwork exists still reads properly.
 */
function renderQuote(doc, quote) {
  const L = 40, R = 555, W = R - L;
  const created = quote.created_at ? new Date(quote.created_at) : new Date();
  const validUntil = new Date(created.getTime() + QUOTE_VALID_DAYS * 864e5);

  const rule = (y, color = '#e3e8ee', width = 1) =>
    doc.moveTo(L, y).lineTo(R, y).strokeColor(color).lineWidth(width).stroke();
  const heading = (text, y) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BLUE).text(text.toUpperCase(), L, y, { width: W });
    return y + 16;
  };

  /* ── Masthead ─────────────────────────────────────────────────────────── */
  // `fit` rather than `width`: the lockup sits on a square canvas, so sizing by width alone made
  // it 86pt tall and the GSTIN line underneath ran straight through it.
  const LOGO_BOX = [78, 62];
  let logoBottom;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, L, 28, { fit: LOGO_BOX });
    logoBottom = 28 + LOGO_BOX[1];
  } else {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(SELLER.brandName, L, 38);
    logoBottom = 62;
  }
  doc.font('Helvetica-Bold').fontSize(26).fillColor(INK).text('QUOTATION', 300, 34, { width: 255, align: 'right' });

  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
    .text(`GSTIN: ${SELLER.gstin}`, L, logoBottom + 8, { width: 240 });
  doc.fontSize(8.5).fillColor(MUTED)
    .text(`Quotation No: ${quote.quote_no || `Q-${quote.id}`}`, 300, 72, { width: 255, align: 'right' })
    .text(`Date of Issue: ${longDate(created)}`, 300, 85, { width: 255, align: 'right' })
    .text(`Valid Until: ${longDate(validUntil)}`, 300, 98, { width: 255, align: 'right' });

  let y = 118;
  rule(y, BLUE, 2);
  y += 14;

  /* ── Buyer / delivery band ────────────────────────────────────────────── */
  const billed = [
    quote.company_name || quote.customer_name || '-',
    quote.contact_person ? `Contact: ${quote.contact_person}` : null,
    quote.contact_number ? `Mobile: ${quote.contact_number}` : null,
    quote.email ? `Email: ${quote.email}` : null,
    quote.gstin ? `GSTIN: ${quote.gstin}` : null,
  ].filter(Boolean).join('\n');
  const shipTo = quote.delivery_address || quote.zone_label || '-';
  const when = quote.delivery_date ? fullDate(quote.delivery_date) : 'To be confirmed';

  const colW = [200, 195, 120];
  const colX = [L, L + colW[0], L + colW[0] + colW[1]];
  const pad = 10;
  doc.font('Helvetica').fontSize(9);
  const bandBody = Math.max(
    doc.heightOfString(billed, { width: colW[0] - pad * 2 }),
    doc.heightOfString(shipTo, { width: colW[1] - pad * 2 }),
    14,
  );
  const bandH = bandBody + 40;
  doc.rect(L, y, W, bandH).fillColor('#f6f8fa').fill();
  doc.rect(L, y, W, bandH).strokeColor('#e3e8ee').lineWidth(1).stroke();
  // Dividers rather than three separate boxes — one band reads as one fact about the order.
  for (const x of [colX[1], colX[2]]) {
    doc.moveTo(x, y).lineTo(x, y + bandH).strokeColor('#e3e8ee').lineWidth(1).stroke();
  }
  const bandLabel = (text, i) =>
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BLUE)
      .text(text, colX[i] + pad, y + 10, { width: colW[i] - pad * 2 });
  bandLabel('BILLED TO', 0); bandLabel('DELIVERY ADDRESS', 1); bandLabel('DELIVERY DATE', 2);
  doc.font('Helvetica').fontSize(9).fillColor(INK)
    .text(billed, colX[0] + pad, y + 26, { width: colW[0] - pad * 2 })
    .text(shipTo, colX[1] + pad, y + 26, { width: colW[1] - pad * 2 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE)
    .text(when, colX[2] + pad, y + 25, { width: colW[2] - pad * 2 });
  y += bandH + 20;

  /* ── Priced lines ─────────────────────────────────────────────────────── */
  y = heading('Order details', y);

  const COL = { desc: L, qty: 344, unit: 400, amt: 478 };
  const CW = { desc: 296, qty: 48, unit: 70, amt: 77 };
  const tableHead = (top) => {
    doc.rect(L, top, W, 22).fillColor(BLUE).fill();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff')
      .text('Description', COL.desc + 8, top + 7, { width: CW.desc - 16 })
      .text('Qty', COL.qty, top + 7, { width: CW.qty, align: 'center' })
      .text('Unit Price', COL.unit, top + 7, { width: CW.unit, align: 'right' })
      .text('Amount', COL.amt, top + 7, { width: CW.amt - 8, align: 'right' });
    return top + 22;
  };
  y = tableHead(y);

  const items = Array.isArray(quote.line_items) ? quote.line_items : [];
  items.forEach((it, i) => {
    const name = it.product_name || '-';
    const spec = [fabricSpec(it), printingSpec(it)].filter(Boolean).join('\n');
    doc.font('Helvetica-Bold').fontSize(9.5);
    const nameH = doc.heightOfString(name, { width: CW.desc - 16 });
    doc.font('Helvetica').fontSize(8.5);
    const specH = spec ? doc.heightOfString(spec, { width: CW.desc - 16 }) + 2 : 0;
    const rowH = Math.max(nameH + specH + 14, 30);

    // Break before drawing, never mid-row: a product split across two pages is unreadable.
    if (y + rowH > 720) { doc.addPage(); y = 50; y = tableHead(y); }

    if (i % 2) { doc.rect(L, y, W, rowH).fillColor('#fafbfc').fill(); }
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
      .text(name, COL.desc + 8, y + 7, { width: CW.desc - 16 });
    if (spec) {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(spec, COL.desc + 8, y + 7 + nameH + 2, { width: CW.desc - 16 });
    }
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
      .text(String(it.qty || 0), COL.qty, y + 7, { width: CW.qty, align: 'center' })
      .text(it.needs_quote ? 'On request' : money(it.price_per_piece), COL.unit, y + 7, { width: CW.unit, align: 'right' })
      .text(it.needs_quote ? '-' : money(it.line_total), COL.amt, y + 7, { width: CW.amt - 8, align: 'right' });
    y += rowH;
    rule(y);
  });

  if (quote.notes) {
    y += 8;
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED)
      .text(`Note: ${quote.notes}`, L, y, { width: W });
    y += doc.heightOfString(`Note: ${quote.notes}`, { width: W }) + 4;
  }
  y += 10;

  /* ── What is payable ──────────────────────────────────────────────────── */
  const grand = Number(quote.grand_total) || 0;
  const advance = Math.round(grand * (ADVANCE_PCT / 100));
  const totalRow = (label, value, opts = {}) => {
    const h = 20;
    if (y + h > 760) { doc.addPage(); y = 50; }
    if (opts.shade) doc.rect(L, y, W, h).fillColor('#f0f4f8').fill();
    const font = opts.bold ? 'Helvetica-Bold' : 'Helvetica';
    doc.font(font).fontSize(opts.bold ? 10 : 9.5).fillColor(opts.bold ? INK : '#333')
      .text(label, L + 8, y + 6, { width: 300 })
      .text(value, 300, y + 6, { width: W - 308, align: 'right' });
    y += h;
    if (!opts.shade) rule(y);
  };
  totalRow('Product Subtotal', money(quote.product_total));
  totalRow('Shipping Charges', money(quote.shipping_charge));
  totalRow('GST (5%)', money(quote.gst_amount));
  totalRow('Grand Total', money(grand), { bold: true, shade: true });
  totalRow(`Advance Payable (${ADVANCE_PCT}%)`, money(advance));
  totalRow('Balance Payable Before Dispatch', money(grand - advance));
  y += 16;

  /* ── Terms, then where to pay ─────────────────────────────────────────── */
  if (y > 620) { doc.addPage(); y = 50; }
  y = heading('Payment terms', y);
  const terms = `${ADVANCE_PCT}% advance is payable to confirm the order and begin production. `
    + `The balance ${100 - ADVANCE_PCT}%, including the shipping shown above, is payable before dispatch.`
    + (quote.delivery_date ? ` Delivery is scheduled for ${fullDate(quote.delivery_date)}.` : '');
  doc.font('Helvetica').fontSize(9).fillColor('#333').text(terms, L, y, { width: W });
  y += doc.heightOfString(terms, { width: W }) + 18;

  if (y + 24 + BANK.length * 20 > 780) { doc.addPage(); y = 50; }
  y = heading('Bank details', y);
  const bankTop = y;
  BANK.forEach(([label, value], i) => {
    const h = 20;
    if (i % 2 === 0) doc.rect(L, y, W, h).fillColor('#f6f8fa').fill();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(label, L + 10, y + 6, { width: 150 });
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(value, L + 170, y + 6, { width: W - 180 });
    y += h;
  });
  doc.rect(L, bankTop, W, y - bankTop).strokeColor('#e3e8ee').lineWidth(1).stroke();
  y += 14;

  const closing = 'Kindly verify all the above details before making the payment. Once the advance payment is completed, '
    + `please share the payment confirmation for order verification. This quotation is valid for ${QUOTE_VALID_DAYS} days from the date of issue.`;
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(closing, L, y, { width: W });
  y += doc.heightOfString(closing, { width: W }) + 6;
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED)
    .text(`Thank you for choosing ${SELLER.brandName} by ${SELLER.legalName}.`, L, y, { width: W });
}

// Standard 4in x 6in thermal shipping label (288pt x 432pt), the size every label printer and
// pre-cut sticker sheet expects. The page itself is created at this size by the caller, so the
// artwork fills the sheet edge to edge — nothing to cut out.
const LABEL_SIZE = [288, 432]; // [width, height] in PDF points at 72dpi

function renderShippingLabel(doc, order) {
  const [PW, PH] = LABEL_SIZE;
  const M = 10, PAD = 9;               // outer border inset, then padding inside it
  const L = M + PAD, R = PW - M - PAD;
  const innerW = R - L;
  const shipTo = order.delivery_location || order.billing_address || '-';
  const name = order.billing_name || order.customer_name || '-';
  const phone = order.billing_mobile || order.contact_number || '-';

  const line = (y) => doc.moveTo(M, y).lineTo(PW - M, y).strokeColor('#999').lineWidth(0.8).stroke();
  // Vertical space is fixed on a label, so long addresses get scaled down rather than
  // overflowing the sheet — a clipped address is a lost parcel.
  const fitFont = (text, size, min, width) => {
    let s = size;
    while (s > min && doc.font('Helvetica').fontSize(s).heightOfString(text, { width }) > 96) s -= 0.5;
    return s;
  };

  let y = M + PAD;

  // ── Header: brand left, order ref right — what the packer matches the parcel on.
  // On a 4in sheet the logo does the branding on its own; repeating "CREWFIT" as text beside it
  // would just cost width that the order ref needs.
  const hasLogo = fs.existsSync(LOGO_PATH);
  if (hasLogo) {
    doc.image(LOGO_PATH, L, y - 2, { width: 40 });
    doc.font('Helvetica').fontSize(6).fillColor('#666').text(SELLER.tagline, L, y + 40, { width: 90 });
  } else {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(SELLER.brandName, L, y + 1);
    doc.font('Helvetica').fontSize(6).fillColor('#666').text(SELLER.tagline, L, y + 16);
  }
  doc.font('Helvetica').fontSize(6).fillColor('#888').text('ORDER REF', L, y + 4, { width: innerW, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#000').text(`CF-${order.sl_no}`, L, y + 13, { width: innerW, align: 'right' });
  y += hasLogo ? 52 : 32;
  line(y);

  // ── Deliver to — the only block a courier really reads, so it takes the largest type
  y += 9;
  doc.font('Helvetica').fontSize(6.5).fillColor('#888').text('DELIVER TO', L, y);
  y += 11;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(name, L, y, { width: innerW });
  y += doc.font('Helvetica-Bold').fontSize(13).heightOfString(name, { width: innerW }) + 2;
  if (order.contact_person && order.contact_person !== name) {
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Attn: ${order.contact_person}`, L, y, { width: innerW });
    y += 13;
  }
  const addrSize = fitFont(shipTo, 10.5, 7, innerW);
  doc.font('Helvetica').fontSize(addrSize).fillColor('#000').text(shipTo, L, y, { width: innerW, lineGap: 1.5 });
  y += doc.heightOfString(shipTo, { width: innerW, lineGap: 1.5 }) + 6;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(`Phone: ${phone}`, L, y);
  y += 18;
  line(y);

  // ── Contents + piece count, side by side to save vertical room
  y += 8;
  doc.font('Helvetica').fontSize(6.5).fillColor('#888').text('TOTAL PIECES', L, y);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(order.qty ? `${order.qty} pcs` : '-', L, y + 9);
  y += 26;

  // The return block is pinned to the bottom, so work out where it starts before drawing the
  // contents — that's the ceiling the per-product list has to stay under.
  const returnLines = [`${SELLER.legalName} (${SELLER.brandName})`, SELLER.address, `Ph: ${SELLER.returnPhone} · GSTIN: ${SELLER.gstin}`];
  const addrH = doc.font('Helvetica').fontSize(7).heightOfString(SELLER.address, { width: innerW, lineGap: 0.5 });
  const blockH = 11 + 10 + addrH + 11;
  const ry0 = PH - M - PAD - blockH;
  const contentsFloor = ry0 - 18; // keep clear of the divider above the return block

  // Legacy/imported orders kept product + sizes in flat columns with line_items empty — fall back
  // to those so those labels still list something instead of coming out blank.
  let items = Array.isArray(order.line_items) ? order.line_items.filter(it => it.product) : [];
  if (!items.length && order.product) {
    items = [{ product: order.product, color: order.color, qty: order.qty, size_breakdown: order.size_breakdown }];
  }

  if (items.length) {
    doc.font('Helvetica').fontSize(6.5).fillColor('#888').text('CONTENTS', L, y);
    y += 10;

    const QTY_W = 40;              // right-hand column reserved for the piece count
    const nameW = innerW - QTY_W - 6;
    let dropped = 0;

    for (const it of items) {
      const name = `${it.product}${it.color ? ` (${it.color})` : ''}`;
      // Strip any "Product: " prefix the flat column carries, so it isn't repeated after the name.
      const sizes = String(it.size_breakdown || '').replace(/^[^:]{1,60}:\s*/, '').trim();
      const nameH = doc.font('Helvetica-Bold').fontSize(8).heightOfString(name, { width: nameW });
      const sizesH = sizes ? doc.font('Helvetica').fontSize(7).heightOfString(sizes, { width: innerW, lineGap: 0.5 }) : 0;
      const rowH = nameH + (sizes ? sizesH + 2 : 0) + 5;

      // Don't spill into the return address — count what didn't fit and say so instead.
      if (y + rowH > contentsFloor) { dropped++; continue; }

      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(name, L, y, { width: nameW });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
        .text(it.qty ? `${it.qty} ${Number(it.qty) === 1 ? 'pc' : 'pcs'}` : '-', L, y, { width: innerW, align: 'right' });
      y += nameH + 1;
      if (sizes) {
        doc.font('Helvetica').fontSize(7).fillColor('#555').text(sizes, L, y, { width: innerW, lineGap: 0.5 });
        y += sizesH + 2;
      }
      y += 4;
    }

    if (dropped) {
      doc.font('Helvetica').fontSize(6.5).fillColor('#888')
        .text(`+ ${dropped} more item${dropped > 1 ? 's' : ''} — see order CF-${order.sl_no}`, L, y, { width: innerW });
    }
  }

  // ── Return address pinned to the bottom so the layout above can breathe
  let ry = ry0;
  line(ry - 8);
  doc.font('Helvetica').fontSize(6.5).fillColor('#888').text('IF UNDELIVERED, RETURN TO', L, ry);
  ry += 10;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(returnLines[0], L, ry, { width: innerW });
  ry += 10;
  doc.font('Helvetica').fontSize(7).fillColor('#444').text(SELLER.address, L, ry, { width: innerW, lineGap: 0.5 });
  ry += addrH + 2;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000').text(returnLines[2], L, ry, { width: innerW });

  doc.rect(M, M, PW - M * 2, PH - M * 2).strokeColor('#000').lineWidth(1.2).stroke();
}

module.exports = {
  renderInvoice, renderProforma, renderQuote, renderShippingLabel, LABEL_SIZE,
  nextInvoiceNumber, nextProformaNumber, taxSplit, SELLER,
};
