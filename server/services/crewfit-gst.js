/**
 * GST sales register for Crewfit (bulk orders).
 *
 * Same workbook shape as the Normless register (services/gst-report.js) so both drop into the same
 * filing process, but sourced from issued tax invoices rather than Shopify orders.
 *
 * Two differences that matter, both following from how Crewfit actually sells:
 *
 *   - Only TAX INVOICES appear. Proformas acknowledge an advance and carry no GST — no liability
 *     arises on an advance for goods (Notification 66/2017), so filing one would declare tax twice.
 *   - One row per HSN within an invoice, not one row per invoice. A single order can carry polos
 *     (6105) and hoodies (6110), and the HSN-wise summary in GSTR-1 has to be able to tell them
 *     apart. Single-HSN invoices — the common case — still produce exactly one row.
 */

const gst = require('./gst-report');

const UQC = 'NOS';
const HOME_STATE = 'Tamil Nadu';
const DEFAULT_HSN = '61091000';

/** Split an invoice into one row per HSN, apportioning its money by each group's product value. */
function invoiceRows(inv) {
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  const groups = new Map();
  for (const it of items) {
    const hsn = it.hsn || DEFAULT_HSN;
    const g = groups.get(hsn) || { hsn, qty: 0, value: 0, products: [] };
    g.qty += parseInt(it.qty, 10) || 0;
    g.value += Number(it.product_total) || 0;
    if (it.product) g.products.push(it.product);
    groups.set(hsn, g);
  }
  if (!groups.size) {
    groups.set(DEFAULT_HSN, { hsn: DEFAULT_HSN, qty: inv.qty || 0, value: Number(inv.taxable) || 0, products: [] });
  }

  const list = [...groups.values()];
  const totalValue = list.reduce((s, g) => s + g.value, 0);
  const taxable = Number(inv.taxable) || 0;
  const gstTotal = Number(inv.gst_amount) || 0;
  const gross = Number(inv.gross) || 0;

  const state = (inv.place_of_supply || '').trim();
  const intraState = state.toLowerCase() === HOME_STATE.toLowerCase();

  // The last group absorbs the rounding remainder so the rows always re-add to the invoice.
  let leftTaxable = taxable, leftGst = gstTotal, leftGross = gross;
  return list.map((g, i) => {
    const last = i === list.length - 1;
    const share = totalValue > 0 ? g.value / totalValue : 1 / list.length;
    const rTaxable = last ? leftTaxable : Math.round(taxable * share * 100) / 100;
    const rGst = last ? leftGst : Math.round(gstTotal * share * 100) / 100;
    const rGross = last ? leftGross : Math.round(gross * share * 100) / 100;
    leftTaxable -= rTaxable; leftGst -= rGst; leftGross -= rGross;

    return {
      order_name: `CF-${inv.sl_no}`,
      date: inv.issue_date,
      // The actual goods, not a fixed description — the Crewfit mix genuinely varies.
      particulars: [...new Set(g.products)].join(', ') || 'Garments',
      company: inv.billing_name || inv.customer_name || '',
      invoice_no: inv.number,
      location: state,
      gst_number: inv.gstin || 'NA',
      gst_pct: (Number(inv.gst_pct) || 0) / 100,
      qty: g.qty,
      rate: g.qty ? rGross / g.qty : 0,
      taxable: rTaxable,
      gst: rGst,
      gross: rGross,
      cgst: intraState ? rGst / 2 : 0,
      sgst: intraState ? rGst / 2 : 0,
      igst: intraState ? 0 : rGst,
      hsn: g.hsn,
      uqc: UQC,
    };
  });
}

/**
 * Issued tax invoices in [from, to], with their order and catalog HSN attached.
 * Cancelled documents are excluded; proformas never appear.
 */
async function fetchInvoices(db, from, to) {
  const r = await db.query(
    `SELECT i.number, TO_CHAR(i.issue_date,'YYYY-MM-DD') AS issue_date, i.qty, i.taxable,
            i.gst_pct, i.gst_amount, i.gross, i.place_of_supply, i.gstin,
            o.sl_no, o.customer_name, o.billing_name, o.line_items
       FROM crewfit_invoices i
       LEFT JOIN crewfit_orders o ON o.id = i.order_id
      WHERE i.doc_type = 'tax_invoice' AND i.status <> 'cancelled'
        AND i.issue_date BETWEEN $1 AND $2
      ORDER BY i.issue_date ASC, i.seq ASC`, [from, to]);

  const products = (await db.query('SELECT name, hsn FROM crewfit_products')).rows;
  const hsnByName = new Map(products.map(p => [p.name, p.hsn]));

  return r.rows.map(inv => {
    let items = [];
    try { items = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []); } catch { items = []; }
    return { ...inv, line_items: items.map(it => ({ ...it, hsn: it.hsn || hsnByName.get(it.product) || DEFAULT_HSN })) };
  });
}

/** Register rows for a period. */
async function buildRows(db, from, to) {
  const invoices = await fetchInvoices(db, from, to);
  return invoices.flatMap(invoiceRows);
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

function summarise(rows) {
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    row_count: rows.length,
    total_qty: rows.reduce((a, r) => a + r.qty, 0),
    taxable_value: sum('taxable'),
    gst_total: sum('gst'),
    gross_total: sum('gross'),
    invoice_from: rows.length ? rows[0].invoice_no : null,
    invoice_to: rows.length ? rows[rows.length - 1].invoice_no : null,
  };
}

/** Totals for a period without generating anything — powers the preview. */
async function previewPeriod(db, from, to) {
  const rows = await buildRows(db, from, to);
  return { ...summarise(rows), period_label: gst.periodLabel(from, to), gaps: await findGaps(db, from, to) };
}

module.exports = {
  buildRows, previewPeriod, summarise, findGaps, invoiceRows,
  buildWorkbook: gst.buildWorkbook, // identical 19-column format to the Normless register
  periodLabel: gst.periodLabel,
};
