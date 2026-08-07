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
// Cotton knit T-shirts/polos — verify this matches your actual product mix before relying on it for filing.
const HSN_CODE = '6109';

const money = (n) => `Rs. ${(Number(n) || 0).toLocaleString('en-IN')}`;

function fyLabel(d) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // FY starts in April
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

async function nextInvoiceNumber(db) {
  const r = await db.query("SELECT nextval('crewfit_invoice_seq') AS n");
  return `CREWFIT/${fyLabel(new Date())}/${String(r.rows[0].n).padStart(4, '0')}`;
}

function renderInvoice(doc, order, invoice, allInvoices) {
  const buyerStateCode = (order.gst_number || '').slice(0, 2);
  const isInterState = buyerStateCode && buyerStateCode !== SELLER.stateCode;

  let headerX = 40;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 40, 34, { width: 58 });
    headerX = 108;
  }
  doc.fontSize(20).fillColor('#1a1a1a').text(SELLER.brandName, headerX, 44);
  doc.fontSize(9).fillColor('#666').text(SELLER.tagline, headerX, 68);

  doc.fontSize(15).fillColor('#1a1a1a')
    .text(invoice.type === 'advance' ? 'TAX INVOICE (ADVANCE)' : 'TAX INVOICE (FINAL)', 300, 44, { width: 255, align: 'right' });
  doc.fontSize(9).fillColor('#444')
    .text(`Invoice No: ${invoice.number}`, 300, 68, { width: 255, align: 'right' })
    .text(`Invoice Date: ${invoice.date}`, 300, 82, { width: 255, align: 'right' })
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
  doc.text(`Phone: ${order.billing_mobile || order.contact_number || '-'}`, 320, by);

  let y = 250;
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
    doc.text(HSN_CODE, 260, y, { width: 50 });
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
  y += 10;

  const rightX = 340;
  const row = (label, val, bold) => {
    doc.fontSize(9).fillColor(bold ? '#1a1a1a' : '#444').font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(label, rightX, y, { width: 120 })
      .text(val, rightX + 120, y, { width: 95, align: 'right' });
    y += 15;
  };
  row('Taxable Value', money(invoice.taxable_value));
  if (isInterState) {
    row(`IGST @ ${invoice.gst_pct}%`, money(invoice.gst_amount));
  } else {
    row(`CGST @ ${(invoice.gst_pct / 2).toFixed(1)}%`, money(invoice.gst_amount / 2));
    row(`SGST @ ${(invoice.gst_pct / 2).toFixed(1)}%`, money(invoice.gst_amount / 2));
  }
  row(`This Invoice Amount (${invoice.type === 'advance' ? 'Advance' : 'Balance'})`, money(invoice.amount), true);

  y += 6;
  doc.fontSize(8).fillColor('#888').text(`Order Grand Total: ${money(order.grand_total)}`, rightX, y, { width: 215, align: 'right' });
  y += 12;
  if (invoice.type === 'balance') {
    const adv = allInvoices.find(i => i.type === 'advance');
    if (adv) doc.fontSize(8).fillColor('#888').text(`Advance already invoiced: ${adv.number}`, rightX, y, { width: 215, align: 'right' });
  }

  doc.fontSize(8).fillColor('#999')
    .text('This is a computer-generated invoice and does not require a physical signature.', 40, 780, { width: 515, align: 'center' });
}

// Quotations aren't tax documents — no sequence number, no GSTIN requirement — just a clean,
// shareable price breakdown for a Crewfit quote.
function renderQuote(doc, quote) {
  let headerX = 40;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 40, 34, { width: 58 });
    headerX = 108;
  }
  doc.fontSize(20).fillColor('#1a1a1a').text(SELLER.brandName, headerX, 44);
  doc.fontSize(9).fillColor('#666').text(SELLER.tagline, headerX, 68);

  doc.fontSize(15).fillColor('#1a1a1a').text('QUOTATION', 300, 44, { width: 255, align: 'right' });
  doc.fontSize(9).fillColor('#444')
    .text(`Quote No: Q-${quote.id}`, 300, 68, { width: 255, align: 'right' })
    .text(`Date: ${new Date(quote.created_at).toISOString().slice(0, 10)}`, 300, 82, { width: 255, align: 'right' });

  doc.moveTo(40, 108).lineTo(555, 108).strokeColor('#ddd').stroke();

  doc.fontSize(9).fillColor('#888').text('FROM', 40, 120);
  doc.fontSize(10).fillColor('#1a1a1a').text(`${SELLER.legalName} (${SELLER.brandName})`, 40, 134);
  doc.fontSize(9).fillColor('#444').text(SELLER.address, 40, 148, { width: 250 });

  doc.fontSize(9).fillColor('#888').text('QUOTED FOR', 320, 120);
  doc.fontSize(10).fillColor('#1a1a1a').text(quote.customer_name || '-', 320, 134);
  doc.fontSize(9).fillColor('#444').text(`Phone: ${quote.contact_number || '-'}`, 320, 148);
  doc.text(`Ship to: ${quote.zone_label || '-'}`, 320, 161);

  let y = 200;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#ddd').stroke();
  y += 8;
  doc.fontSize(9).fillColor('#888');
  doc.text('#', 40, y, { width: 20 });
  doc.text('Product', 65, y, { width: 260 });
  doc.text('Qty', 335, y, { width: 40, align: 'right' });
  doc.text('Rate', 380, y, { width: 75, align: 'right' });
  doc.text('Amount', 460, y, { width: 95, align: 'right' });
  y += 14;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#ddd').stroke();
  y += 8;

  const items = Array.isArray(quote.line_items) ? quote.line_items : [];
  doc.fontSize(9).fillColor('#1a1a1a');
  items.forEach((it, i) => {
    doc.text(String(i + 1), 40, y, { width: 20 });
    doc.text(it.product_name || '-', 65, y, { width: 260 });
    doc.text(String(it.qty || 0), 335, y, { width: 40, align: 'right' });
    doc.text(it.needs_quote ? 'On request' : money(it.price_per_piece), 380, y, { width: 75, align: 'right' });
    doc.text(it.needs_quote ? '-' : money(it.line_total), 460, y, { width: 95, align: 'right' });
    y += 16;
  });
  y += 4;
  doc.moveTo(40, y).lineTo(555, y).strokeColor('#ddd').stroke();
  y += 10;

  const rightX = 340;
  const row = (label, val, bold) => {
    doc.fontSize(9).fillColor(bold ? '#1a1a1a' : '#444').font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(label, rightX, y, { width: 120 })
      .text(val, rightX + 120, y, { width: 95, align: 'right' });
    y += 15;
  };
  row('Product Total', money(quote.product_total));
  row('Shipping', money(quote.shipping_charge));
  row('GST @ 5%', money(quote.gst_amount));
  row('Grand Total', money(quote.grand_total), true);

  if (quote.notes) {
    y += 10;
    doc.fontSize(8).fillColor('#888').text(`Notes: ${quote.notes}`, 40, y, { width: 515 });
  }

  doc.fontSize(8).fillColor('#999')
    .text('This is a quotation, not a tax invoice, and is valid for 7 days from the date above. Prices are subject to change after that.', 40, 780, { width: 515, align: 'center' });
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

module.exports = { renderInvoice, renderQuote, renderShippingLabel, LABEL_SIZE, nextInvoiceNumber, SELLER };
