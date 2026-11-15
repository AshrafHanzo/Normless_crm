/**
 * Reading the old vendor trackers (Google Sheets, one tab per quotation) into Purchasing.
 *
 * The layout, as in "Spark 3D Print Tracker – EDS0109136 (Dsk & Msk)":
 *
 *   Quotation No. : EDS0109136 | | Date : 29-Oct-2026 | | Payment Cycle
 *   Total Received | 216 | 152 | | Total Billed | 177000 | 35400        ← total, instalment size
 *   Date | Mask | Disk set | | Paid So far | 70800
 *   27/10/2026 | 10 | | | Balance | 106200
 *   28/10/2026 | 12 | | | Date | Amount                                 ← payments start below
 *   29/10/2026 | 17 | | | 11/03/2026 | 35400
 *   …
 *
 * Read by labels, not fixed cells, so a column moved over still reads. Dates were typed in two
 * styles (27/10/2026 and 11/6/2026): a part over 12 settles it; otherwise the reading that keeps
 * the dates moving forward from the one before is taken, and flagged for a look.
 *
 * The sheets never held the quantity ordered or a UTR: the import asks for the first, and leaves
 * the payments marked "Add UTR".
 */

const ExcelJS = require('exceljs');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Plain text of a cell, whatever exceljs handed back. */
function text(v) {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if (v.result !== undefined) return text(v.result);
        if (v.richText) return v.richText.map(r => r.text).join('');
        if (v.text !== undefined) return String(v.text);
        return '';
    }
    return String(v).trim();
}
const num = (v) => {
    const s = text(v).replace(/[₹,\s]/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
};

/**
 * Every way a cell could be a date. Returns { candidates: [ymd], raw } or null.
 * Day/month order unknown when both parts are 12 or under.
 */
function dateCandidates(v) {
    if (v instanceof Date) return { candidates: [v.toISOString().slice(0, 10)], raw: v.toISOString().slice(0, 10) };
    const s = text(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m && valid(+m[1], +m[2], +m[3])) return { candidates: [ymd(+m[1], +m[2], +m[3])], raw: s };
    m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})$/);
    if (m && MONTHS[m[2].toLowerCase()]) {
        const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
        if (valid(y, MONTHS[m[2].toLowerCase()], +m[1])) return { candidates: [ymd(y, MONTHS[m[2].toLowerCase()], +m[1])], raw: s };
    }
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (!m) return null;
    const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const out = [];
    if (valid(y, b, a)) out.push(ymd(y, b, a));         // day/month
    if (a !== b && valid(y, a, b)) out.push(ymd(y, a, b)); // month/day
    return out.length ? { candidates: out, raw: s } : null;
}

/** Settle a list of possibly-ambiguous dates in order, each kept on or after the one before. */
function settle(cells, start) {
    let prev = start;
    return cells.map(c => {
        if (c.candidates.length === 1) { prev = c.candidates[0]; return { date: prev, raw: c.raw, ambiguous: false }; }
        const after = c.candidates.filter(d => !prev || d >= prev);
        const pool = after.length ? after : c.candidates;
        const pick = prev ? pool.sort((x, y) => Math.abs(daysBetween(prev, x)) - Math.abs(daysBetween(prev, y)))[0] : pool[0];
        prev = pick;
        return { date: pick, raw: c.raw, ambiguous: true, other: c.candidates.find(d => d !== pick) };
    });
}

/** A CSV file as a grid (quoted fields, commas and newlines inside quotes). */
function parseCsv(textIn) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const s = textIn.replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quoted) {
            if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && s[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

/** The workbook's tabs (or the CSV) as grids of cell values. */
async function toGrids(buffer, fileName) {
    if (/\.csv$/i.test(fileName)) {
        return [{ tab: fileName.replace(/\.csv$/i, ''), rows: parseCsv(buffer.toString('utf8')) }];
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb.worksheets.map(ws => {
        const rows = [];
        ws.eachRow({ includeEmpty: true }, (r, n) => {
            const vals = [];
            for (let c = 1; c <= Math.max(r.cellCount, ws.columnCount || 0); c++) vals.push(r.getCell(c).value);
            rows[n - 1] = vals;
        });
        return { tab: ws.name, rows: Array.from(rows, r => r || []) };
    });
}

/** Find the first cell whose text matches; returns { r, c, m }. */
function find(rows, re, from = { r: 0, c: 0 }) {
    for (let r = from.r; r < rows.length; r++) {
        for (let c = 0; c < (rows[r] || []).length; c++) {
            const m = text(rows[r][c]).match(re);
            if (m) return { r, c, m };
        }
    }
    return null;
}
/** The first number to the right of a cell on its row. */
const numRight = (rows, at, skip = 0) => {
    const found = [];
    for (let c = at.c + 1; c < (rows[at.r] || []).length; c++) { const n = num(rows[at.r][c]); if (n != null) found.push(n); }
    return found[skip] ?? null;
};

/** Guess the vendor from "Spark 3D Print Tracker - EDS0109136 (Dsk & Msk)". */
function vendorGuess(fileName, tab) {
    const base = String(fileName || '').replace(/\.(csv|xlsx)$/i, '').split(' - ')[0];
    const name = base.replace(/\btracker\b/i, '').replace(/\s+/g, ' ').trim();
    return name || String(tab || '').trim();
}

/** One tab → what it says, plus what it couldn't tell. */
function parseSheet(rows, { fileName, tab }) {
    const warnings = [];
    const quoteCell = find(rows, /^quotation\s*no\.?\s*:?\s*(.*)$/i);
    const quote_no = quoteCell ? (quoteCell.m[1] || text(rows[quoteCell.r][quoteCell.c + 1])).trim() : null;
    const dateCell = find(rows, /^date\s*:\s*(.+)$/i);
    const quoteDate = dateCell ? dateCandidates(dateCell.m[1]) : null;
    const quote_date = quoteDate?.candidates[0] || null;
    if (!quote_no) warnings.push('No quotation number found');

    // Deliveries: the "Date | product | product" header in the first column, then a row per day.
    const head = find(rows, /^date$/i);
    const products = [];
    const deliveries = [];
    if (head && head.c === 0) {
        for (let c = 1; c < rows[head.r].length; c++) {
            const name = text(rows[head.r][c]);
            if (!name) break;
            products.push({ name, col: c });
        }
        const cells = [];
        for (let r = head.r + 1; r < rows.length; r++) {
            const d = dateCandidates(rows[r]?.[0]);
            if (!d) continue;
            const qty = {};
            for (const p of products) { const n = num(rows[r][p.col]); if (n > 0) qty[p.name] = n; }
            if (Object.keys(qty).length) cells.push({ ...d, qty });
        }
        settle(cells, null).forEach((s, i) => deliveries.push({ ...s, qty: cells[i].qty }));
    } else warnings.push('No delivery table (a "Date" column with the products beside it) found');

    // The right-hand block.
    const totalReceivedCell = find(rows, /^total received$/i);
    const received_sheet = {};
    if (totalReceivedCell) products.forEach(p => { const n = num(rows[totalReceivedCell.r][p.col]); if (n != null) received_sheet[p.name] = n; });
    const billedCell = find(rows, /^total billed$/i);
    const total = billedCell ? numRight(rows, billedCell, 0) : null;
    const instalment = billedCell ? numRight(rows, billedCell, 1) : null;
    const paidCell = find(rows, /^paid so far$/i);
    const paid_sheet = paidCell ? numRight(rows, paidCell) : null;
    const balanceCell = find(rows, /^balance$/i);
    const balance_sheet = balanceCell ? numRight(rows, balanceCell) : null;
    if (total == null) warnings.push('No "Total Billed" found');

    // Payments: under the "Date | Amount" pair on the right.
    const payments = [];
    const payHead = (() => {
        for (let r = 0; r < rows.length; r++) {
            for (let c = 1; c < (rows[r] || []).length - 1; c++) {
                if (/^date$/i.test(text(rows[r][c])) && /^amount$/i.test(text(rows[r][c + 1]))) return { r, c };
            }
        }
        return null;
    })();
    if (payHead) {
        const cells = [];
        for (let r = payHead.r + 1; r < rows.length; r++) {
            const d = dateCandidates(rows[r]?.[payHead.c]);
            const amount = num(rows[r]?.[payHead.c + 1]);
            if (d && amount > 0) cells.push({ ...d, amount });
        }
        settle(cells, quote_date).forEach((s, i) => payments.push({ ...s, amount: cells[i].amount }));
    }

    // Cross-checks against the sheet's own totals.
    const received = {};
    for (const d of deliveries) for (const [p, n] of Object.entries(d.qty)) received[p] = (received[p] || 0) + n;
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    const checks = [];
    for (const p of products) {
        if (received_sheet[p.name] != null) checks.push({ what: `${p.name} received`, sheet: received_sheet[p.name], counted: received[p.name] || 0 });
    }
    if (paid_sheet != null) checks.push({ what: 'Paid so far', sheet: paid_sheet, counted: paid });
    if (balance_sheet != null && total != null) checks.push({ what: 'Balance', sheet: balance_sheet, counted: total - paid });
    for (const c of checks) c.ok = Math.abs(c.sheet - c.counted) < 0.5;

    const firstDelivery = deliveries.map(d => d.date).sort()[0];
    return {
        tab, file: fileName,
        vendor_guess: vendorGuess(fileName, tab),
        quote_no, quote_date,
        order_date: [quote_date, firstDelivery].filter(Boolean).sort()[0] || null,
        products: products.map(p => ({ name: p.name, received: received[p.name] || 0 })),
        deliveries, payments, total, instalment,
        checks, warnings,
    };
}

async function read(buffer, fileName) {
    const grids = await toGrids(buffer, fileName);
    return grids
        .map(g => parseSheet(g.rows, { fileName, tab: g.tab }))
        // A tab with nothing a tracker has (a notes tab, an empty one) is left out.
        .filter(s => s.quote_no || s.deliveries.length || s.payments.length || s.total);
}

module.exports = { read, parseSheet, parseCsv, dateCandidates, settle };
