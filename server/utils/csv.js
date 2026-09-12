/**
 * CSV in and out, the way spreadsheets actually write it.
 *
 * Small on purpose. The only rules that matter are RFC 4180's: a field containing a comma, a quote
 * or a line break is wrapped in quotes, and a quote inside it is doubled. Excel adds a BOM at the
 * front of a UTF-8 file and ends lines with CRLF; both are tolerated on the way in and neither is
 * produced on the way out except the BOM, which is what makes Excel open the export as UTF-8.
 */

const quote = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** rows: array of objects; columns: [{ key, label }] in output order. */
function toCsv(rows, columns) {
    const head = columns.map(c => quote(c.label)).join(',');
    const body = rows.map(r => columns.map(c => quote(r[c.key])).join(','));
    return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

/** Text → array of string arrays. Handles quoted fields, doubled quotes, CRLF and a leading BOM. */
function parseCsv(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // A trailing blank line is not a record.
    return rows.filter(r => r.some(f => String(f).trim() !== ''));
}

/**
 * Rows → objects keyed by a normalised header: lower-case, spaces and punctuation collapsed to
 * underscores, so "On shelf", "on_shelf" and "ON SHELF" are the same column.
 */
function parseCsvObjects(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { headers: [], records: [] };
    const norm = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const headers = rows[0].map(norm);
    const records = rows.slice(1).map((r, i) => {
        const o = { _line: i + 2 };   // 1-based, header is line 1
        headers.forEach((h, j) => { if (h) o[h] = (r[j] ?? '').trim(); });
        return o;
    });
    return { headers, records };
}

module.exports = { toCsv, parseCsv, parseCsvObjects };
