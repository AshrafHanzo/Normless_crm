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

module.exports = { renderInvoice, nextInvoiceNumber, SELLER };
