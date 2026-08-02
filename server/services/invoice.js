const fs = require('fs');
const path = require('path');

const SELLER = {
  legalName: 'Normless',
  brandName: 'CREWFIT',
  tagline: 'A brand of Normless',
  address: 'No 152, 1st Street, Vignesh Nagar, Gerugambakkam, Chennai - 600122, Tamil Nadu, India',
  gstin: '33AAYFN3674M1ZF',
  stateCode: '33',
  state: 'Tamil Nadu',
};
// Drop a PNG/JPG at this path to have it appear on the invoice header — optional, skipped if missing.
const LOGO_PATH = path.join(__dirname, '..', '..', 'client', 'logo', 'crewfit-logo.png');
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
    doc.image(LOGO_PATH, 40, 40, { width: 46 });
    headerX = 96;
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
    doc.image(LOGO_PATH, 40, 40, { width: 46 });
    headerX = 96;
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

// A courier-ready address label. Sized to sit in the top portion of a plain A4 sheet so it prints
// on any office printer and gets cut along the border — no thermal label printer assumed.
function renderShippingLabel(doc, order) {
  const L = 40, R = 555, W = R - L, PAD = 16;
  const innerW = W - PAD * 2;
  const shipTo = order.delivery_location || order.billing_address || '-';
  const name = order.billing_name || order.customer_name || '-';
  const phone = order.billing_mobile || order.contact_number || '-';
  const top = 40;

  const line = (y) => doc.moveTo(L, y).lineTo(R, y).strokeColor('#bbb').lineWidth(1).stroke();
  let y = top + PAD;

  // ── Header: brand on the left, order ref big on the right (what the warehouse matches on)
  let headerX = L + PAD;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, L + PAD, y, { width: 38 });
    headerX = L + PAD + 48;
  }
  doc.font('Helvetica-Bold').fontSize(17).fillColor('#1a1a1a').text(SELLER.brandName, headerX, y + 2);
  doc.font('Helvetica').fontSize(8).fillColor('#666').text(SELLER.tagline, headerX, y + 22);
  doc.font('Helvetica').fontSize(8).fillColor('#888').text('ORDER REF', L + PAD, y, { width: innerW, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1a1a').text(`CF-${order.sl_no}`, L + PAD, y + 11, { width: innerW, align: 'right' });
  y += 44;
  line(y);

  // ── Deliver to — the block that actually matters, so it gets the largest type on the page
  y += 12;
  doc.font('Helvetica').fontSize(8).fillColor('#888').text('DELIVER TO', L + PAD, y);
  y += 13;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(name, L + PAD, y, { width: innerW });
  y += doc.heightOfString(name, { width: innerW }) + 3;
  if (order.contact_person && order.contact_person !== name) {
    doc.font('Helvetica').fontSize(11).fillColor('#333').text(`Attn: ${order.contact_person}`, L + PAD, y, { width: innerW });
    y += 16;
  }
  doc.font('Helvetica').fontSize(12).fillColor('#1a1a1a');
  doc.text(shipTo, L + PAD, y, { width: innerW, lineGap: 2 });
  y += doc.heightOfString(shipTo, { width: innerW, lineGap: 2 }) + 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(`Phone: ${phone}`, L + PAD, y);
  y += 22;
  line(y);

  // ── Return address
  y += 12;
  doc.font('Helvetica').fontSize(8).fillColor('#888').text('IF UNDELIVERED, RETURN TO', L + PAD, y);
  y += 12;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a1a').text(`${SELLER.legalName} (${SELLER.brandName})`, L + PAD, y);
  y += 13;
  doc.font('Helvetica').fontSize(9).fillColor('#444').text(SELLER.address, L + PAD, y, { width: innerW, lineGap: 1 });
  y += doc.heightOfString(SELLER.address, { width: innerW, lineGap: 1 }) + 4;
  doc.text(`GSTIN: ${SELLER.gstin}`, L + PAD, y);
  y += 18;
  line(y);

  // ── Consignment strip: what the courier desk and the packer need at a glance
  y += 11;
  const cell = (label, val, x, w) => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#888').text(label, x, y, { width: w });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a1a').text(val || '-', x, y + 11, { width: w });
  };
  const cw = innerW / 3;
  cell('COURIER', order.mot, L + PAD, cw - 8);
  cell('TRACKING ID', order.tracking_link, L + PAD + cw, cw - 8);
  cell('TOTAL PIECES', order.qty ? `${order.qty} pcs` : '-', L + PAD + cw * 2, cw - 8);
  y += 34;

  const items = Array.isArray(order.line_items) ? order.line_items.filter(it => it.product) : [];
  if (items.length) {
    const contents = items.map(it => `${it.product}${it.color ? ` (${it.color})` : ''} x${it.qty || 0}`).join(' · ');
    doc.font('Helvetica').fontSize(7.5).fillColor('#888').text('CONTENTS', L + PAD, y);
    y += 10;
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(contents, L + PAD, y, { width: innerW, lineGap: 1 });
    y += doc.heightOfString(contents, { width: innerW, lineGap: 1 }) + 4;
  }
  y += PAD;

  doc.rect(L, top, W, y - top).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor('#999')
    .text('Cut along the border and paste on the parcel.', L, y + 8, { width: W, align: 'center' });
}

module.exports = { renderInvoice, renderQuote, renderShippingLabel, nextInvoiceNumber, SELLER };
