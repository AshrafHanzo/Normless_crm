/**
 * Turning printed statement lines into transactions.
 *
 * Driven by the header row rather than by one bank's layout: the header names the columns and its
 * x positions say where each one sits, so every later line can be split by position. That is what
 * makes a blank cell readable — a withdrawal and a deposit are the same digits in different
 * places, and only the position says which one it is.
 *
 * A narration that wraps onto the next line is part of the transaction above it. Banks wrap
 * constantly, and a wrapped line has no date, which is how one is recognised.
 *
 * Nothing is "roughly right" here. Every row is checked against the running balance the bank
 * printed beside it: previous balance + credit - debit has to equal this row's balance. If the
 * chain holds from the first row to the last, no line was dropped, misread or double-counted —
 * which is the only honest way to promise that a report misses nothing.
 */

const COLUMN_PATTERNS = [
    { key: 'date', re: /^(date|txn date|transaction date|tran date)$/i },
    { key: 'narration', re: /^(narration|particulars|description|transaction remarks|remarks)$/i },
    { key: 'ref', re: /^(chq\.?\/?ref\.?\s*no\.?|ref no\.?|cheque no\.?|chq no\.?|reference)$/i },
    { key: 'value_date', re: /^(value dt\.?|value date)$/i },
    { key: 'debit', re: /^(withdrawal amt\.?|withdrawal|debit|debit amount|dr|withdrawals?)$/i },
    { key: 'credit', re: /^(deposit amt\.?|deposit|credit|credit amount|cr|deposits?)$/i },
    { key: 'balance', re: /^(closing balance|balance|running balance|balance \(inr\))$/i },
];

const DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
const AMOUNT = /^-?[\d,]+(?:\.\d{1,2})?(?:\s?(?:CR|DR))?$/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => {
    const t = clean(v).replace(/[^0-9.-]/g, '');
    if (!t || t === '-' || t === '.') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** DD/MM/YY as Indian statements print it. Two-digit years are this century. */
function toDate(v) {
    const m = DATE.exec(clean(v));
    if (!m) return null;
    let [, d, mo, y] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    d = Number(d); mo = Number(mo);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The header row, and where each of its columns begins.
 *
 * A header fragment can be split across several pieces ("Withdrawal" / "Amt."), so pieces are
 * joined left to right until one of the known column names is matched.
 */
function findColumns(lines) {
    for (const line of lines) {
        const hits = [];
        const parts = line.parts;
        for (let i = 0; i < parts.length; i++) {
            for (let j = i; j < Math.min(i + 3, parts.length); j++) {
                const label = clean(parts.slice(i, j + 1).map(p => p.text).join(' '));
                const col = COLUMN_PATTERNS.find(c => c.re.test(label));
                if (col && !hits.some(h => h.key === col.key)) {
                    hits.push({ key: col.key, x: parts[i].x, end: parts[j].x + parts[j].w });
                    i = j;
                    break;
                }
            }
        }
        // A real header names a date, something to read, and a balance. Anything less is a line of
        // the covering letter that happens to contain the word "date".
        if (hits.some(h => h.key === 'date') && hits.some(h => h.key === 'balance')
            && hits.some(h => ['narration', 'ref'].includes(h.key))) {
            return hits.sort((a, b) => a.x - b.x);
        }
    }
    return null;
}

/** Which column a fragment sits in: the last one whose left edge it has passed. */
function columnAt(columns, x, w) {
    const mid = x + (w || 0) / 2;
    let found = columns[0];
    for (const c of columns) if (mid >= c.x - 6) found = c;
    return found.key;
}

/** Split a printed line into its columns, keeping the pieces in each. */
function cellsOf(columns, line) {
    const cells = {};
    for (const p of line.parts) {
        const key = columnAt(columns, p.x, p.w);
        cells[key] = cells[key] ? `${cells[key]} ${p.text}` : p.text;
    }
    return cells;
}

const END_OF_TABLE = /(statement summary|\*\*\*\s*end of statement|this is a (computer|system) generated)/i;

/**
 * Every transaction in the document, in the order it was printed.
 *
 * Amounts are read from the columns they sit in, never guessed from sign or order: a 450 under
 * "Deposit" and a 450 under "Withdrawal" look identical as text.
 */
function parseTransactions(pages) {
    const all = pages.flatMap(p => p.lines);
    const columns = findColumns(all);
    if (!columns) return { columns: null, rows: [] };

    const rows = [];
    let started = false;

    for (const page of pages) {
        for (const line of page.lines) {
            const cells = cellsOf(columns, line);
            const date = toDate(cells.date);

            if (!started) {
                // Everything above the first dated row is the letterhead.
                if (!date) continue;
                started = true;
            }
            if (END_OF_TABLE.test(line.text)) return { columns, rows };

            if (date) {
                rows.push({
                    txn_date: date,
                    value_date: toDate(cells.value_date),
                    narration: clean(cells.narration),
                    ref_no: clean(cells.ref) || null,
                    debit: num(cells.debit) || 0,
                    credit: num(cells.credit) || 0,
                    balance: num(cells.balance),
                    row_no: rows.length + 1,
                });
                continue;
            }

            // No date: a wrapped narration belonging to the row above. Page furniture — headers
            // repeated at the top of page two, page numbers — has no narration cell to add.
            const last = rows[rows.length - 1];
            const extra = clean(cells.narration);
            if (last && extra && !AMOUNT.test(extra) && !/^page \d+/i.test(extra) && extra.length > 1) {
                last.narration = `${last.narration} ${extra}`.trim();
            }
        }
    }
    return { columns, rows };
}

/**
 * Does the statement add up?
 *
 * Row by row, against the balance the bank printed. The first row is checked against the opening
 * balance when the statement states one; after that each row is checked against the row above, so
 * a single missed or misread line shows up as a break with the exact rupee difference.
 */
function reconcile(rows, opening) {
    const breaks = [];
    let running = typeof opening === 'number' ? opening : (rows[0]?.balance ?? null);
    if (rows.length && typeof opening === 'number') {
        // Check the first row against the stated opening balance too.
        const expected = Math.round((opening + rows[0].credit - rows[0].debit) * 100) / 100;
        if (rows[0].balance !== null && Math.abs(expected - rows[0].balance) > 0.009) {
            breaks.push({ row_no: rows[0].row_no, expected, printed: rows[0].balance, diff: Math.round((rows[0].balance - expected) * 100) / 100 });
        }
        running = rows[0].balance;
    } else if (rows.length) {
        running = rows[0].balance;
    }

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (running === null || r.balance === null) { running = r.balance; continue; }
        const expected = Math.round((running + r.credit - r.debit) * 100) / 100;
        if (Math.abs(expected - r.balance) > 0.009) {
            breaks.push({ row_no: r.row_no, expected, printed: r.balance, diff: Math.round((r.balance - expected) * 100) / 100, narration: r.narration });
        }
        running = r.balance;
    }

    const debits = rows.reduce((n, r) => n + (r.debit || 0), 0);
    const credits = rows.reduce((n, r) => n + (r.credit || 0), 0);
    return {
        ok: breaks.length === 0 && rows.length > 0,
        breaks: breaks.slice(0, 20),
        debits: Math.round(debits * 100) / 100,
        credits: Math.round(credits * 100) / 100,
        opening_balance: typeof opening === 'number' ? opening
            : (rows[0] ? Math.round((rows[0].balance - rows[0].credit + rows[0].debit) * 100) / 100 : null),
        closing_balance: rows.length ? rows[rows.length - 1].balance : null,
    };
}

module.exports = { parseTransactions, reconcile, findColumns, toDate, num, clean };
