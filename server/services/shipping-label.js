/**
 * Shipping labels drawn the way the Delhivery portal prints them (Settings → Shipping Label
 * Config: thermal 4 × 6 in, company logo, invoice value, seller and return details, product name,
 * quantity and price, more pages when the products don't fit).
 *
 * The API's own PDF (packing_slip with pdf=true) is Delhivery's older generic layout, so the label
 * is built here from the same call's data instead: Delhivery still supplies the barcodes, sort
 * code, logos and addresses, and the CRM adds the products with their prices.
 */

const db = require('../db/connection');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (v) => (!v ? '' : /^(data:|https?:)/.test(v) ? v : `data:image/png;base64,${v}`);
const amount = (v) => (Number(v) || 0).toFixed(2);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(v) {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) return '';
    // Delhivery's timestamps are Indian time without a zone; read them as written.
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    const [y, mo, da, h, mi] = m ? m.slice(1).map(Number) : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
    return `${String(da).padStart(2, '0')}-${MONTHS[mo - 1]}-${y} | ${((h + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const ROWS_FIRST = 4;   // product rows that fit on the first page
const ROWS_MORE = 11;   // and on each page after it

/** The products on the label: the order's lines with prices, or Delhivery's description. */
function productsOf(p, ship) {
    let lines = [];
    try { lines = JSON.parse(ship?.line_items_json || '[]'); } catch { lines = []; }
    lines = (Array.isArray(lines) ? lines : []).filter(li => (Number(li.quantity) || 0) > 0);
    // A typed-in (manual) shipment, or details changed for this parcel: what Delhivery holds wins.
    if (!lines.length || ship?.source === 'manual') {
        return [{ name: p.prd || ship?.products_desc || 'Apparel', sub: '', qty: p.qty || ship?.pieces || 1, price: null, total: Number(p.rs) || null }];
    }
    return lines.map(li => {
        const variant = li.variant && li.variant !== 'Default Title' ? li.variant : '';
        const qty = Number(li.quantity) || 1;
        const price = Number(li.price) || 0;
        return { name: li.title || 'Item', sub: [variant, li.sku ? `SKU:${li.sku}` : ''].filter(Boolean).join(' · '), qty, price, total: price * qty };
    });
}

const productRows = (rows) => rows.map(r => `<tr><td style="width:50%;text-align:left"><span>${esc(r.name)}</span>${r.sub ? `<br><span style="font-weight:700;line-height:30px;font-size:24px">${esc(r.sub)}</span>` : ''}</td>
<td style="width:10%">${esc(r.qty)}</td><td style="width:10%">${r.price == null ? '' : amount(r.price)}</td><td style="width:10%">${r.total == null ? '' : amount(r.total)}</td></tr>`).join('');

const productTable = (rows, height) => `<div class="row" style="height:${height}px;overflow:hidden">
<table style="font-family:Arial;color:#000;font-weight:400;font-size:28px;line-height:40px;width:100%;margin:10px 0;text-align:right;border-spacing:15px;border-collapse:separate">
<thead style="font-weight:700;font-size:24px;line-height:30px;vertical-align:top"><tr><th style="width:50%;text-align:left">Product Name &amp; SKU</th><th style="width:10%">Qty.</th><th style="width:10%">Price</th><th style="width:10%">Total</th></tr></thead>
<tbody style="vertical-align:top">${productRows(rows)}</tbody></table></div>`;

const footer = (p, page, pages) => `<div class="row" style="min-height:82px;padding-bottom:5px">
<table style="font-family:Arial;color:#000;font-size:24px;line-height:30px;width:100%;margin:10px 0 5px"><tbody style="vertical-align:top"><tr>
<td style="width:70%;white-space:normal">${p.radd ? `<span>Return Address: ${esc(p.radd)}</span>` : ''}</td>
<td style="text-align:right;width:30%;vertical-align:bottom;white-space:nowrap"><span>Page ${page} of ${pages}</span></td></tr></tbody></table></div>`;

function shipTo(p, ship) {
    const prepaid = String(p.pt || ship?.payment_mode || '').toLowerCase() !== 'cod';
    const mode = (p.mot || ship?.shipping_mode || 'S').toString().toUpperCase().startsWith('E') ? 'Express' : 'Surface';
    const value = prepaid ? (Number(p.rs) || Number(ship?.total_amount) || 0) : (Number(p.cod) || Number(ship?.cod_amount) || 0);
    const city = [p.destination_city || ship?.consignee_city, p.st || ship?.consignee_state].filter(Boolean);
    return `<div class="row" style="height:320px;overflow:hidden;position:relative"><div style="position:absolute;top:50%;transform:translateY(-50%);width:100%">
<table style="font-family:Arial;color:#000;font-size:28px;line-height:40px;width:100%"><tbody><tr>
<td style="width:60%;border-right:2px solid #D9D9D9"><table style="width:100%;border-spacing:5px;border-collapse:separate"><tbody>
<tr><td style="font-size:28px;line-height:40px"><span style="font-size:40px">Ship to - <span style="font-weight:700">${esc(p.name || ship?.consignee_name)}</span></span><br>${esc(p.address || ship?.consignee_address)}</td></tr>
<tr><td><span style="font-size:40px;font-weight:700;line-height:60px">${esc(city[0] || '')}${city[1] ? ` (${esc(city[1])})` : ''}</span></td></tr>
<tr><td><span style="font-size:36px;font-weight:700;line-height:50px">PIN - ${esc(p.pin || ship?.consignee_pincode)}</span></td></tr>
</tbody></table></td>
<td style="width:40%"><table style="font-family:Arial;color:#000;font-size:28px;line-height:40px;width:100%;margin:10px 0 10px 10px"><tbody>
<tr><td style="border-bottom:2px solid #D9D9D9"><div class="row" style="max-height:130px;overflow:hidden;padding-bottom:10px">
<span class="block" style="font-weight:700;font-size:28px">${prepaid ? 'Prepaid' : 'COD'} - ${mode}</span>
<span class="block" style="font-weight:700;line-height:50px;font-size:36px">INR ${esc(Math.round(value))}</span>
${p.invoice_reference ? `<span class="block" style="line-height:28px;font-size:24px">Inv# ${esc(p.invoice_reference)}</span>` : ''}
</div></td></tr>
<tr><td><div class="row" style="height:70px;overflow:hidden;padding-top:10px"><span class="block" style="font-weight:700;font-size:28px">Date</span>
<span class="block" style="line-height:28px;font-size:24px">${esc(when(p.cd || ship?.manifested_at))}</span></div></td></tr>
</tbody></table></td></tr></tbody></table></div></div>`;
}

/** One parcel: the first page with barcodes, then pages for the rest of the products. */
function labelPages(p, ship) {
    const items = productsOf(p, ship);
    const more = [];
    for (let i = ROWS_FIRST; i < items.length; i += ROWS_MORE) more.push(items.slice(i, i + ROWS_MORE));
    const pages = 1 + more.length;
    const awb = esc(p.wbn || ship?.awb);
    const gst = p.seller_gst_tin || p.client_gst_tin;
    const first = `<section class="label"><div class="frame">
<div class="row" style="height:125px;overflow:hidden;padding-bottom:10px"><table height="100%" width="100%"><tbody><tr>
<td style="width:33%;vertical-align:middle">${p.cl_logo ? `<span class="block"><img src="${esc(img(p.cl_logo))}" style="max-width:100%;max-height:125px"></span>` : `<span style="font-size:40px;font-weight:700;color:#000">${esc(p.snm || 'Normless')}</span>`}</td>
<td style="width:34%;text-align:center;vertical-align:middle"></td>
<td style="width:33%;text-align:right;vertical-align:middle">${p.delhivery_logo ? `<span class="block"><img src="${esc(img(p.delhivery_logo))}" style="max-width:100%;max-height:125px;height:90px"></span>` : ''}</td>
</tr></tbody></table></div><hr>
<div class="row"><table width="100%" style="margin:20px 0 10px"><tbody>
<tr><td><span class="block" style="font-size:36px;color:#000;font-weight:500;line-height:50px">AWB# ${awb}</span></td></tr>
<tr><td style="text-align:center">${p.barcode ? `<span class="block" style="margin-top:15px"><img src="${esc(img(p.barcode))}" style="max-width:766px;max-height:184px;width:100%"></span>` : ''}</td></tr>
</tbody></table>
<table width="100%"><tbody><tr style="font-size:28px;font-weight:400;line-height:40px;color:#000">
<td style="width:18%"><span class="block">${esc(p.pin || ship?.consignee_pincode)}</span></td>
<td style="width:52%"><span class="block" style="font-weight:700;text-align:center">AWB# ${awb}</span></td>
<td style="width:30%;text-align:right"><span class="block" style="font-weight:700;white-space:nowrap">${esc(p.sort_code || '')}</span></td>
</tr></tbody></table></div><hr>
${shipTo(p, ship)}<hr>
<div class="row" style="height:170px;overflow:hidden;padding:12px 0"><table style="font-family:Arial;color:#000;font-size:24px;line-height:32px;width:100%"><tbody><tr>
<td style="width:60%;border-right:2px solid #D9D9D9"><span style="font-size:28px">Seller:</span><span style="font-weight:700;font-size:28px">${esc(p.snm || 'Normless')}</span>${p.sadd ? `<br><span>${esc(p.sadd)}</span>` : ''}${gst ? `<br><span>GST: ${esc(gst)}</span>` : ''}</td>
<td style="width:40%;padding-left:10px"><span class="block" style="font-size:40px;font-weight:500;line-height:40px">${esc(p.oid || ship?.delhivery_order || ship?.order_number)}</span>
${p.oid_barcode ? `<span class="block" style="margin-top:16px"><img src="${esc(img(p.oid_barcode))}" style="max-width:480px;max-height:95px;width:100%"></span>` : ''}</td>
</tr></tbody></table></div><hr>
<div class="row" style="height:560px">${productTable(items.slice(0, ROWS_FIRST), 550)}</div>
${footer(p, 1, pages)}</div></section>`;
    const rest = more.map((rows, i) => `<section class="label"><div class="frame">
<div class="row" style="padding:10px 0"><span class="block" style="font-size:36px;color:#000;font-weight:500;line-height:50px">AWB#${awb}</span></div><hr>
${shipTo(p, ship)}<hr>
<div class="row" style="height:1080px">${productTable(rows, 1060)}</div>
${footer(p, i + 2, pages)}</div></section>`);
    return [first, ...rest].join('');
}

const PAGE = (body, count) => `<!doctype html><html><head><meta charset="utf-8"><title>Labels · ${count}</title>
<style>
@page { size: 4in 6in; margin: 0 }
* { box-sizing: content-box }
html, body { margin: 0; padding: 0; background: #e5e5e5 }
table { table-layout: fixed; border-collapse: collapse; border-spacing: 0 }
.block, table td { overflow: hidden }
table td { padding: 0; word-wrap: break-word }
.block { display: block; position: relative }
.row { width: 100% }
hr { border: 0; border-top: 2px solid #d9d9d9; margin: 8px 0 }
/* The portal's label is drawn 1200 × 1765 px and printed onto a 4 × 6 in label. */
.label { width: 1200px; height: 1765px; zoom: 0.32; margin: 0 auto; padding: 0; background: #fff; overflow: hidden;
  font-size: 14px; line-height: 20px; font-family: Arial, sans-serif; color: #3d445c; break-after: page; page-break-after: always }
.label:last-child { break-after: auto; page-break-after: auto }
.frame { border: 4px solid #111; padding: 12px; margin: 16px; height: 1709px; overflow: hidden }
.bar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; justify-content: center; padding: 10px; background: #111; color: #fff; font: 14px Arial, sans-serif; z-index: 1 }
.bar button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 0; cursor: pointer }
@media screen { .label { margin: 24px auto; box-shadow: 0 2px 12px rgba(0,0,0,.2) } }
@media print { .bar { display: none } html, body { background: #fff } }
</style></head><body>
<div class="bar"><span>${count} label${count === 1 ? '' : 's'} · 4 × 6 in, as in the Delhivery portal</span><button onclick="window.print()">Print</button></div>
${body}
<script>
// Print once every barcode and logo has loaded.
(function () {
  var imgs = Array.prototype.slice.call(document.images);
  var left = imgs.filter(function (i) { return !i.complete; }).length;
  function go() { setTimeout(function () { window.print(); }, 150); }
  if (!left) return go();
  imgs.forEach(function (i) { if (!i.complete) { i.onload = i.onerror = function () { if (--left === 0) go(); }; } });
  setTimeout(function () { if (left > 0) { left = 0; go(); } }, 8000);
})();
</script></body></html>`;

/**
 * The printable labels for these AWBs, in the order given. `fetchSlips(awbs)` returns Delhivery's
 * packing-slip data for them.
 */
async function labelsHtml(awbs, fetchSlips) {
    const list = [...new Set(awbs.map(String).filter(Boolean))];
    if (!list.length) throw Object.assign(new Error('Choose at least one shipment'), { status: 400 });
    const slips = await fetchSlips(list);
    const byAwb = new Map(slips.map(p => [String(p.wbn || p.waybill), p]));
    const ships = (await db.query(
        `SELECT s.*, o.line_items_json FROM shipments s LEFT JOIN orders o ON o.order_number = s.order_number WHERE s.awb = ANY($1)`, [list])).rows;
    const shipBy = new Map(ships.map(s => [String(s.awb), s]));
    const missing = list.filter(a => !byAwb.has(a));
    if (missing.length === list.length) throw Object.assign(new Error('Delhivery returned no label data for these AWBs'), { status: 502 });
    const body = list.filter(a => byAwb.has(a)).map(a => labelPages(byAwb.get(a), shipBy.get(a))).join('');
    return { html: PAGE(body, list.length - missing.length), missing };
}

module.exports = { labelsHtml };
