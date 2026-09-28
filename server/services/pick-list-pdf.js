/**
 * The pick list as a printed sheet.
 *
 * One table per garment type, with the edition named once above its own colours and sizes. The
 * paper is read standing at a press with a stack of blanks, so it is ruled and banded rather than
 * pretty: the eye has to find "Black / L / 3" without losing its place across the page.
 *
 * Kept out of the route so it can be rendered from made-up rows in a test — page breaks are the
 * part of a printed document that only ever shows up on the second page.
 */

const PDFDocument = require('pdfkit');

const L = 40, R = 555, W = R - L;
const TOP = 50, BOTTOM = 762;          // the band of the page rows may occupy
const INK = '#15161a', MUTED = '#6b7280', RULE = '#e4e6eb', BAND = '#f3f4f6', ZEBRA = '#fafafa';
// A line that can come off the RTO shelf is the one thing on this sheet that must not be printed,
// so it is the one thing on it that is coloured.
const SHELF = '#b45309', SHELF_BG = '#fff7ed';

// Edition · Colour · Size · Qty · RTO · Print · Orders. The three counts are narrow and
// right-aligned so they line up in columns the eye can run down.
const COL = {
    edition: L + 10, colour: L + 160, size: L + 232,
    qty: L + 270, rto: L + 300, print: L + 334, orders: L + 372,
};
const WID = {
    edition: 145, colour: 68, size: 34,
    qty: 26, rto: 30, print: 32, orders: R - (L + 372) - 10,
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Returns the finished document — the caller pipes it wherever it is going. */
module.exports = function renderPickListPdf({ rows = [], summary = {}, period = {} }) {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const span = period.from && period.to
        ? (period.from === period.to ? period.from : `${period.from} — ${period.to}`)
        : 'All open orders';

    /* ── Masthead ───────────────────────────────────────────────────────────────────── */
    doc.font('Helvetica-Bold').fontSize(19).fillColor(INK).text('Pick list', L, 42);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(span, L, 66);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text('Unfulfilled orders only - held, cancelled and refunded orders are left out.', L, 81);
    if (summary.from_shelf) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(SHELF)
            .text(`Highlighted rows are already in the building — take ${summary.from_shelf} from the RTO shelf instead of printing.`, L, 91);
    }

    // The three numbers anyone checks first, as their own block in the corner.
    const stat = (label, value, x) => {
        doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(String(value ?? 0), x, 44, { width: 58, align: 'right' });
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, 63, { width: 58, align: 'right' });
    };
    stat('units', summary.units, R - 254);
    stat('lines', summary.lines, R - 190);
    stat('orders', summary.orders, R - 126);
    // Said up front: it is the number that changes what the floor does today.
    const shelf = summary.from_shelf || 0;
    doc.font('Helvetica-Bold').fontSize(15).fillColor(shelf ? SHELF : MUTED)
        .text(String(shelf), R - 62, 44, { width: 58, align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor(shelf ? SHELF : MUTED)
        .text('FROM RTO', R - 62, 63, { width: 58, align: 'right' });

    const ruleY = summary.from_shelf ? 105 : 96;
    doc.moveTo(L, ruleY).lineTo(R, ruleY).strokeColor(INK).lineWidth(1.2).stroke();
    let y = ruleY + 16;

    /* ── A table per garment type ───────────────────────────────────────────────────── */
    const byType = [];
    for (const r of rows) {
        const last = byType[byType.length - 1];
        if (last && last.type === r.type) last.rows.push(r);
        else byType.push({ type: r.type, rows: [r] });
    }

    const tableHead = () => {
        doc.rect(L, y, W, 18).fillColor(BAND).fill();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
        doc.text('EDITION', COL.edition, y + 6, { width: WID.edition });
        doc.text('COLOUR', COL.colour, y + 6, { width: WID.colour });
        doc.text('SIZE', COL.size, y + 6, { width: WID.size });
        doc.text('QTY', COL.qty, y + 6, { width: WID.qty, align: 'right' });
        doc.fillColor(SHELF).text('RTO', COL.rto, y + 6, { width: WID.rto, align: 'right' });
        doc.fillColor(MUTED).text('PRINT', COL.print, y + 6, { width: WID.print, align: 'right' });
        doc.text('ORDERS', COL.orders, y + 6, { width: WID.orders });
        y += 18;
    };

    for (const section of byType) {
        const units = section.rows.reduce((n, r) => n + r.qty, 0);
        // A section heading with no rows under it is a heading on the wrong page.
        if (y + 64 > BOTTOM) { doc.addPage(); y = TOP; }

        doc.rect(L, y, W, 24).fillColor(INK).fill();
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(section.type, L + 10, y + 7);
        const fromShelf = section.rows.reduce((n, r) => n + (r.rto || 0), 0);
        doc.font('Helvetica').fontSize(9).fillColor('#d7d9de')
            .text(`${plural(units, 'unit')} · ${plural(section.rows.length, 'line')}${fromShelf ? ` · ${fromShelf} from the RTO shelf` : ''}`,
                L, y + 8, { width: W - 10, align: 'right' });
        y += 24;
        tableHead();

        let edition = null, stripe = 0;
        for (const r of section.rows) {
            const orders = (r.orders || []).join('  ');
            doc.font('Helvetica').fontSize(7.5);
            // Rows grow to fit the orders rather than truncating them: the order number is how a
            // finished piece finds its customer.
            const rowH = Math.max(doc.heightOfString(orders, { width: WID.orders }) + 9, 17);

            if (y + rowH > BOTTOM) {
                doc.addPage();
                y = TOP;
                // Carried over: say which table this is, and repeat its column headings.
                doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED)
                    .text(`${section.type} (continued)`, L, y);
                y += 16;
                tableHead();
                edition = null;   // name the edition again at the top of the new page
            }

            // The band alternates per EDITION, not per row: an edition with four sizes should read
            // as one block, which striping row by row breaks apart.
            const fresh = r.edition !== edition;
            if (fresh) stripe++;
            if (fresh && stripe > 1) doc.moveTo(L, y).lineTo(R, y).strokeColor(RULE).lineWidth(0.8).stroke();
            // The shelf tint wins over the stripe: this row is an instruction, not decoration.
            if (r.rto > 0) {
                doc.rect(L, y, W, rowH).fillColor(SHELF_BG).fill();
                doc.rect(L, y, 3, rowH).fillColor(SHELF).fill();
            } else if (stripe % 2 === 0) {
                doc.rect(L, y, W, rowH).fillColor(ZEBRA).fill();
            }

            if (fresh) {
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
                    .text(r.edition, COL.edition, y + 5, { width: WID.edition, ellipsis: true });
                edition = r.edition;
            }
            doc.font('Helvetica').fontSize(8.5).fillColor(INK)
                .text(r.color, COL.colour, y + 5, { width: WID.colour, ellipsis: true })
                .text(r.size, COL.size, y + 5, { width: WID.size });
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
                .text(String(r.qty), COL.qty, y + 4, { width: WID.qty, align: 'right' });
            // Take this many off the shelf, print the rest. A dash rather than a zero, so the eye
            // finds the rows that have a number in them. No arrow glyph: the standard PDF fonts
            // have no U+21A9, and pdfkit draws the bytes it does have instead — "!©1".
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor(r.rto ? SHELF : '#c9cdd4')
                .text(r.rto ? String(r.rto) : '-', COL.rto, y + 4, { width: WID.rto, align: 'right' });
            doc.font(r.rto ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(r.qty - r.rto ? INK : '#c9cdd4')
                .text(String(r.qty - r.rto), COL.print, y + 4, { width: WID.print, align: 'right' });
            doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
                .text(orders, COL.orders, y + 5.5, { width: WID.orders });
            y += rowH;
        }
        doc.moveTo(L, y).lineTo(R, y).strokeColor(RULE).lineWidth(0.8).stroke();
        y += 22;
    }

    if (!rows.length) {
        doc.font('Helvetica').fontSize(11).fillColor(MUTED).text('Nothing waiting to go out in this period.', L, y);
    }

    /* ── Footer on every page, added once the page count is known ───────────────────── */
    const pages = doc.bufferedPageRange();
    const stamp = new Date().toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    for (let i = 0; i < pages.count; i++) {
        doc.switchToPage(pages.start + i);
        doc.moveTo(L, 782).lineTo(R, 782).strokeColor(RULE).lineWidth(0.8).stroke();
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
            .text(`Normless CRM · generated ${stamp}`, L, 790, { width: W / 2 })
            .text(`Page ${i + 1} of ${pages.count}`, L + W / 2, 790, { width: W / 2, align: 'right' });
    }

    doc.end();
    return doc;
};
