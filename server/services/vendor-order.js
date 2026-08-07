/**
 * Crewfit → vendor purchase orders: the PDF the vendor receives and the WhatsApp text that
 * accompanies it.
 *
 * A vendor order is a production spec, not an invoice: what to make, in which colours, and how
 * many of each size. Prices are optional and only appear once a rate has actually been entered,
 * since the money side is settled later against the vendor's own bill.
 */

const fs = require('fs');
const path = require('path');
const { SELLER } = require('./invoice');

const LOGO_PATH = path.join(__dirname, '..', '..', 'client', 'logo', 'cf_logo', 'cf_black.png');
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

const INK = '#111111';
const MUTED = '#6b7280';
const LINE = '#d4d4d8';
const HEAD_BG = '#f4f4f5';

const money = (n) => `Rs. ${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Sizes actually used anywhere in this order, so empty columns never reach the page. */
function usedSizes(items) {
    const used = new Set();
    for (const item of items || []) {
        for (const c of item.colors || []) {
            for (const [size, qty] of Object.entries(c.sizes || {})) {
                if (Number(qty) > 0) used.add(size);
            }
        }
    }
    const known = SIZES.filter(s => used.has(s));
    // Anything hand-typed that isn't a standard size still has to be printed.
    const extra = [...used].filter(s => !SIZES.includes(s)).sort();
    return [...known, ...extra];
}

const colorQty = (c) => Object.values(c.sizes || {}).reduce((sum, q) => sum + (Number(q) || 0), 0);
const itemQty = (item) => (item.colors || []).reduce((sum, c) => sum + colorQty(c), 0);

function totals(items) {
    const list = items || [];
    const qty = list.reduce((sum, i) => sum + itemQty(i), 0);
    const priced = list.filter(i => Number(i.rate) > 0);
    const amount = priced.reduce((sum, i) => sum + Number(i.rate) * itemQty(i), 0);
    return { qty, amount, hasPricing: priced.length > 0 };
}

const ymd = (d) => {
    if (!d) return '';
    const s = String(d).slice(0, 10);
    const [y, m, day] = s.split('-');
    return `${day}/${m}/${y}`;
};

const refLabel = (order) => `VO-${String(order.ref_no ?? order.id ?? '').padStart(3, '0')}`;

/**
 * The message that goes out on WhatsApp. Plain text with the same content as the PDF, because
 * vendors routinely read the message on a phone and never open the attachment.
 */
function buildVendorMessage(order) {
    const items = order.items || [];
    const { qty, amount, hasPricing } = totals(items);
    const L = [`*CREWFIT — Purchase Order ${refLabel(order)}*`, ''];
    L.push(`Vendor: ${order.vendor}`);
    L.push(`Date: ${ymd(order.order_date)}`);
    if (order.delivery_date) L.push(`Expected delivery: ${ymd(order.delivery_date)}`);
    L.push('');

    items.forEach((item, i) => {
        const header = [item.product_type || 'Item', item.gsm ? `${item.gsm} GSM` : null].filter(Boolean).join(' · ');
        L.push(`${items.length > 1 ? `${i + 1}. ` : ''}*${header}*`);
        for (const c of item.colors || []) {
            const breakdown = Object.entries(c.sizes || {})
                .filter(([, q]) => Number(q) > 0)
                .map(([s, q]) => `${s}-${q}`).join(', ');
            if (!breakdown) continue;
            L.push(`   ${c.color || 'Colour'}: ${breakdown}  (${colorQty(c)} pcs)`);
        }
        if (Number(item.rate) > 0) L.push(`   Rate: ${money(item.rate)}/pc`);
        L.push(`   Subtotal: ${itemQty(item)} pcs`);
        L.push('');
    });

    L.push(`*Total: ${qty} pcs*`);
    if (hasPricing) L.push(`*Order value: ${money(amount)}*`);
    if (order.notes) L.push('', `Note: ${order.notes}`);
    L.push('', 'Please confirm receipt and share the expected delivery date.', '', `— ${SELLER.brandName}`);
    return L.join('\n');
}

/** Draw one product block: header strip, then a colour × size matrix. Returns the new y. */
function renderItem(doc, item, y, opts) {
    const { x, width, showRate } = opts;
    const sizes = usedSizes([item]);
    const colors = (item.colors || []).filter(c => colorQty(c) > 0);
    if (!colors.length) return y;

    const title = [item.product_type || 'Item', item.gsm ? `${item.gsm} GSM` : null].filter(Boolean).join('  ·  ');
    doc.rect(x, y, width, 20).fill(HEAD_BG);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(title, x + 8, y + 6, { width: width - 130 });
    if (showRate && Number(item.rate) > 0) {
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
            .text(`${money(item.rate)}/pc`, x + width - 122, y + 7, { width: 114, align: 'right' });
    }
    y += 20;

    // Colour names are short, so the colour column is capped and the size columns share the rest.
    // Letting colour take the slack instead pushed a 4-size order's numbers into the right margin.
    const totalW = 52;
    const colorW = Math.max(110, Math.min(170, width * 0.26));
    const sizeW = (width - colorW - totalW) / Math.max(sizes.length, 1);

    const headerRow = (label, cells, bold) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(INK);
        doc.text(label, x + 6, y + 6, { width: colorW - 12 });
        cells.forEach((text, i) => {
            doc.text(String(text), x + colorW + (i * sizeW), y + 6, { width: sizeW, align: 'center' });
        });
        doc.font('Helvetica-Bold').text(String(cells.total ?? ''), x + colorW + (sizes.length * sizeW), y + 6, { width: totalW, align: 'center' });
    };

    // size header
    doc.rect(x, y, width, 18).fillAndStroke('#ffffff', LINE);
    const head = sizes.slice();
    head.total = 'TOTAL';
    headerRow('COLOUR', head, true);
    y += 18;

    for (const c of colors) {
        doc.rect(x, y, width, 18).fillAndStroke('#ffffff', LINE);
        const row = sizes.map(s => (Number(c.sizes?.[s]) > 0 ? c.sizes[s] : '—'));
        row.total = colorQty(c);
        headerRow(c.color || 'Colour', row, false);
        y += 18;
    }

    // item subtotal
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
        .text(`${itemQty(item)} pcs`, x, y + 4, { width: width - 6, align: 'right' });
    return y + 18;
}

/** Render the whole purchase order onto an existing PDFKit document. */
function renderVendorOrder(doc, order) {
    const M = 40;
    const width = doc.page.width - M * 2;
    let y = M;

    if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, M, y - 4, { width: 54 });
    }
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text('PURCHASE ORDER', M + 66, y, { width: width - 66 });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text(`${SELLER.legalName} · ${SELLER.address}`, M + 66, y + 19, { width: width - 200 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
        .text(refLabel(order), M + width - 150, y, { width: 150, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
        .text(ymd(order.order_date), M + width - 150, y + 16, { width: 150, align: 'right' });
    if (order.delivery_date) {
        doc.fontSize(8.5).text(`Delivery by ${ymd(order.delivery_date)}`, M + width - 180, y + 30, { width: 180, align: 'right' });
    }

    y += 48;
    doc.moveTo(M, y).lineTo(M + width, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 14;

    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('VENDOR', M, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(order.vendor || '—', M, y + 12);
    if (order.vendor_phone) {
        doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(order.vendor_phone, M, y + 27);
        y += 14;
    }
    y += 42;

    const { qty, amount, hasPricing } = totals(order.items);
    for (const item of order.items || []) {
        // Keep a product block off the very bottom of the page.
        if (y > doc.page.height - 150) { doc.addPage(); y = M; }
        y = renderItem(doc, item, y, { x: M, width, showRate: hasPricing }) + 14;
    }

    if (y > doc.page.height - 110) { doc.addPage(); y = M; }
    doc.moveTo(M, y).lineTo(M + width, y).strokeColor(LINE).stroke();
    y += 10;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
        .text(`TOTAL: ${qty} pcs`, M, y, { width: width / 2 });
    if (hasPricing) {
        doc.text(money(amount), M + width / 2, y, { width: width / 2, align: 'right' });
    }
    y += 24;

    if (order.notes) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text('NOTES', M, y);
        doc.font('Helvetica').fontSize(9).fillColor(INK).text(order.notes, M, y + 12, { width });
        y += 18 + doc.heightOfString(order.notes, { width });
    }

    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`${SELLER.brandName} · ${SELLER.tagline}`, M, doc.page.height - 46, { width, align: 'center' });
}

module.exports = { renderVendorOrder, buildVendorMessage, totals, itemQty, colorQty, usedSizes, refLabel, SIZES };
