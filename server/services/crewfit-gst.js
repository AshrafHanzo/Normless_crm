/**
 * GST sales register for Crewfit (bulk orders), and the Crewfit rows of the Normless register.
 *
 * Same workbook shape as the Normless register so both drop into the same filing process, but
 * sourced from issued tax invoices rather than Shopify orders. What the auditor settled on when
 * filing August 2026:
 *
 *   - Only TAX INVOICES appear. Proformas acknowledge an advance and carry no GST — no liability
 *     arises on an advance for goods (Notification 66/2017), so filing one would declare tax twice.
 *   - The Crewfit register is B2B only: invoices on the NLCF series, for customers with a GSTIN.
 *     A B2C Crewfit invoice sits on the shared NL series and is filed in the Normless register,
 *     between that day's Shopify orders — see services/invoice-numbers.js.
 *   - One row per invoice, not one per HSN. A mixed order (polos and hoodies) is filed under
 *     the heading that carries most of its value, with every product named in Particulars.
 */

const workbook = require('./gst-workbook');
const { NL, NLCF } = require('./invoice-numbers');

const HOME_STATE = 'Tamil Nadu';

/** The single register line for a tax invoice. */
function invoiceRow(inv) {
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  // The HSN the invoice is filed under: the one behind most of its value.
  const byHsn = new Map();
  for (const it of items) {
    const hsn = it.hsn || workbook.DEFAULT_HSN;
    byHsn.set(hsn, (byHsn.get(hsn) || 0) + (Number(it.product_total) || 0));
  }
  const hsn = [...byHsn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || workbook.DEFAULT_HSN;

  const taxable = Number(inv.taxable) || 0;
  const gst = Number(inv.gst_amount) || 0;
  const gross = Number(inv.gross) || 0;
  const qty = parseInt(inv.qty, 10) || 0;
  const state = (inv.place_of_supply || '').trim();
  const intraState = state.toLowerCase() === HOME_STATE.toLowerCase();

  return {
    order_name: `CF-${inv.sl_no}`,
    date: inv.issue_date,
    // The actual goods, not a fixed description — the Crewfit mix genuinely varies.
    particulars: [...new Set(items.map(it => it.product).filter(Boolean))].join(', ') || 'Garments',
    company: inv.billing_name || inv.customer_name || '',
    invoice_no: inv.number,
    location: state,
    gst_number: inv.gstin || 'NA',
    gst_pct: (Number(inv.gst_pct) || 0) / 100,
    qty,
    rate: qty ? gross / qty : 0,
    taxable,
    gst,
    gross,
    cgst: intraState ? gst / 2 : 0,
    sgst: intraState ? gst / 2 : 0,
    igst: intraState ? 0 : gst,
    hsn,
    uqc: workbook.UQC,
    // For ordering alongside Shopify rows in the Normless register.
    seq: inv.seq,
    kind: 'crewfit',
    tiebreak: inv.id,
  };
}

/**
 * Issued tax invoices on one series in [from, to], with their order and catalog HSN attached.
 * Cancelled documents are excluded; proformas never appear.
 */
async function fetchInvoices(db, from, to, series) {
  const r = await db.query(
    `SELECT i.id, i.number, i.seq, TO_CHAR(i.issue_date,'YYYY-MM-DD') AS issue_date, i.qty, i.taxable,
            i.gst_pct, i.gst_amount, i.gross, i.place_of_supply, i.gstin,
            o.sl_no, o.customer_name, o.billing_name, o.line_items
       FROM crewfit_invoices i
       LEFT JOIN crewfit_orders o ON o.id = i.order_id
      WHERE i.doc_type = 'tax_invoice' AND i.status <> 'cancelled' AND i.series = $3
        AND i.issue_date BETWEEN $1 AND $2
      ORDER BY i.seq ASC`, [from, to, series]);

  const products = (await db.query('SELECT name, hsn FROM crewfit_products')).rows;
  const hsnByName = new Map(products.map(p => [p.name, p.hsn]));

  return r.rows.map(inv => {
    let items = [];
    try { items = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []); } catch { items = []; }
    return { ...inv, line_items: items.map(it => ({ ...it, hsn: it.hsn || hsnByName.get(it.product) || workbook.DEFAULT_HSN })) };
  });
}

/** B2B register rows for a period. */
async function buildRows(db, from, to) {
  return (await fetchInvoices(db, from, to, NLCF)).map(invoiceRow);
}

/** The B2C Crewfit rows that belong in the Normless register for a period. */
async function normlessRows(db, from, to) {
  return (await fetchInvoices(db, from, to, NL)).map(invoiceRow);
}

/**
 * Orders that should have been invoiced in this period but weren't, so an unbilled supply can't
 * slip out of the return unnoticed. Mirrors the completeness guard on the Shopify side.
 */
async function findGaps(db, from, to) {
  const r = await db.query(
    `SELECT o.sl_no, o.customer_name, o.grand_total, o.status, o.payment_status,
            TO_CHAR(o.dispatch_date,'YYYY-MM-DD') AS dispatch_date
       FROM crewfit_orders o
      WHERE o.payment_status = 'Fully Paid'
        AND COALESCE(o.dispatch_date, o.order_date) BETWEEN $1 AND $2
        AND NOT EXISTS (
          SELECT 1 FROM crewfit_invoices i
           WHERE i.order_id = o.id AND i.doc_type = 'tax_invoice' AND i.status <> 'cancelled')
      ORDER BY o.sl_no`, [from, to]);
  return r.rows;
}

/** Totals for a period without generating anything — powers the preview. */
async function previewPeriod(db, from, to) {
  const rows = await buildRows(db, from, to);
  const b2c = await normlessRows(db, from, to);
  return {
    ...workbook.summarise(rows),
    period_label: workbook.periodLabel(from, to),
    gaps: await findGaps(db, from, to),
    // Filed in the Normless register, not here — shown so nobody goes looking for them.
    b2c_count: b2c.length,
    b2c_gross: b2c.reduce((s, r) => s + r.gross, 0),
  };
}

module.exports = {
  buildRows, normlessRows, previewPeriod, findGaps, invoiceRow, fetchInvoices,
  summarise: workbook.summarise,
  buildWorkbook: workbook.buildWorkbook,
  periodLabel: workbook.periodLabel,
};
