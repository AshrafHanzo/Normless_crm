/**
 * Turning printed statement lines into transactions.
 *
 * Driven by the header row rather than one bank's layout: the header names the columns and says
 * where each one sits. Text columns are read by their left edge and amount columns by their right,
 * because amounts are right-aligned — and which column an amount sits in is the only thing that
 * says whether money came in or went out.
 *
 * Narrations wrap, and wrap mid-word: HDFC prints them in forty-character strips, one per line.
 * A strip that begins with a space is printed a space further left, which is how the gap survives
 * into a PDF that has no idea it was ever one string. Measuring that shift is what tells
 * "UPI-GUNASEKAR" + "R-GUNASRR@YBL" (one payee, GUNASEKAR R) from "@OKA" + "XIS" (one handle,
 * @okaxis). Joining them any other way corrupts one or the other.
 *
 * Nothing here is "roughly right". Every row is checked against the running balance printed beside
 * it, and the whole statement against the bank's own summary — so a parse that drops or misreads
 * a line is reported rather than quietly believed.
 */

const COLUMN_PATTERNS = [
    { key: 'date', re: /^(date|txn date|transaction date|tran date)$/i, align: 'left' },
    { key: 'narration', re: /^(narration|particulars|description|transaction remarks|remarks)$/i, align: 'left' },
    { key: 'ref', re: /^(chq\.?\s*\/?\s*ref\.?\s*no\.?|ref no\.?|cheque no\.?|chq no\.?|reference)$/i, align: 'left' },
    { key: 'value_date', re: /^(value dt\.?|value date)$/i, align: 'left' },
    { key: 'debit', re: /^(withdrawal amt\.?|withdrawal|debit|debit amount|dr|withdrawals?)$/i, align: 'right' },
    { key: 'credit', re: /^(deposit amt\.?|deposit|credit|credit amount|cr|deposits?)$/i, align: 'right' },
    { key: 'balance', re: /^(closing balance|balance|running balance|balance \(inr\))$/i, align: 'right' },
];

const DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
const AMOUNT = /^[\d,]+\.\d{2}$/;
const END_OF_TABLE = /(statement summary|\*\*\*\s*end of statement)/i;

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => {
    const t = String(v ?? '').replace(/[^0-9.-]/g, '');
    if (!t || t === '-' || t === '.') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** DD/MM/YY as Indian statements print it. Two-digit years are this century. */
function toDate(v) {
    const m = DATE.exec(String(v ?? '').trim());
    if (!m) return null;
    let [, d, mo, y] = m;
    y = y.length === 2 ? 2000 + Number(y) : Number(y);
    d = Number(d); mo = Number(mo);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The header row of a page, and the span of each column in it.
 *
 * A header fragment can arrive in pieces ("Withdrawal" then "Amt."), so pieces are joined left to
 * right until one of the known names matches.
 */
function findHeader(lines) {
    for (const line of lines) {
        const hits = [];
        const parts = line.parts;
        for (let i = 0; i < parts.length; i++) {
            for (let j = i; j < Math.min(i + 3, parts.length); j++) {
                const label = clean(parts.slice(i, j + 1).map(p => p.text).join(' '));
                const col = COLUMN_PATTERNS.find(c => c.re.test(label));
                if (col && !hits.some(h => h.key === col.key)) {
                    hits.push({ key: col.key, align: col.align, left: parts[i].x, right: parts[j].x + parts[j].w });
                    i = j;
                    break;
                }
            }
        }
        // A real header names a date, something to read and a balance. Anything less is a line of
        // the covering letter that happens to contain the word "date".
        const has = (k) => hits.some(h => h.key === k);
        if (has('date') && has('balance') && (has('narration') || has('ref'))) {
            return { y: line.y, columns: hits.sort((a, b) => a.left - b.left) };
        }
    }
    return null;
}

/**
 * Where the columns actually are, measured from the rows themselves.
 *
 * The header only says which columns exist and in what order. It cannot say where they are: a
 * centred heading sits nowhere near its column's text — "Narration" is printed at x=144 above a
 * column of text that starts at x=72 — so bands taken from the headings put every narration in the
 * date column. The rows know better. Their left edges fall into tight clusters, one per column,
 * and those clusters are the columns.
 */
function clusters(values, gap, rows) {
    // A column's edge is a position nearly every row shares. Text inside a column lands wherever
    // its words happen to fall, so without this the whole narration — every fragment of it —
    // chains into one cluster that starts halfway across the column.
    const tally = new Map();
    for (const v of values) {
        const k = Math.round(v);
        tally.set(k, (tally.get(k) || 0) + 1);
    }
    const floor = Math.max(8, Math.round((rows || 0) * 0.15));
    const peaks = [...tally.entries()].filter(([, n]) => n >= floor).map(([v]) => v);
    const sorted = (peaks.length ? peaks : [...values]).sort((a, b) => a - b);

    const out = [];
    for (const v of sorted) {
        const last = out[out.length - 1];
        if (last && v - last.values[last.values.length - 1] <= gap) last.values.push(v);
        else out.push({ values: [v] });
    }
    // The commonest position in a cluster, not its edge: a strip nudged left by a leading space is
    // the exception, and the exception must not become the column.
    return out.map(c => {
        const mode = c.values.reduce((best, v) =>
            ((tally.get(Math.round(v)) || 0) > (tally.get(Math.round(best)) || 0) ? v : best), c.values[0]);
        return { at: Math.round(mode), count: c.values.reduce((n, v) => n + (tally.get(Math.round(v)) || 1), 0) };
    });
}

/** Pair measured positions with the columns the header named, in order where the counts agree. */
function mapColumns(found, keys, headerPositions) {
    if (found.length === keys.length) return Object.fromEntries(keys.map((k, i) => [k, found[i].at]));
    // Counts disagree — a period with no credits prints no credit column. Fall back to whichever
    // heading each measured position sits nearest.
    const out = {};
    for (const f of found) {
        const key = keys.reduce((best, k) =>
            Math.abs(headerPositions[k] - f.at) < Math.abs(headerPositions[best] - f.at) ? k : best, keys[0]);
        if (out[key] === undefined) out[key] = f.at;
    }
    return out;
}

function measureColumns(pages, header) {
    const dateLeft = (header.columns.find(c => c.key === 'date') || {}).left ?? 34;
    const textKeys = ['date', 'narration', 'ref', 'value_date'].filter(k => header.columns.some(c => c.key === k));
    const amountKeys = ['debit', 'credit', 'balance'].filter(k => header.columns.some(c => c.key === k));

    const lefts = [], rights = [];
    let dated = 0;
    for (const page of pages) {
        for (const line of page.lines) {
            const first = line.parts[0];
            // Only rows that start with a date in the date column: the letterhead has dates too,
            // and they sit wherever the label before them ended.
            if (!first || !DATE.test(first.text.trim()) || Math.abs(first.x - dateLeft) > 20) continue;
            dated++;
            for (const p of line.parts) {
                const text = p.text.trim();
                if (!text) continue;
                if (AMOUNT.test(text)) rights.push(p.x + p.w);
                else lefts.push(p.x);
            }
        }
    }
    if (!lefts.length) return null;

    const headerLeft = Object.fromEntries(header.columns.map(c => [c.key, c.left]));
    const headerRight = Object.fromEntries(header.columns.map(c => [c.key, c.right]));
    const left = mapColumns(clusters(lefts, 8, dated), textKeys, headerLeft);
    const right = mapColumns(clusters(rights, 20, dated), amountKeys, headerRight);

    // Each text column runs until the next one starts; the last stops where the amounts begin.
    const bounds = {};
    const order = textKeys.filter(k => left[k] !== undefined);
    for (let i = 0; i < order.length; i++) {
        const next = order[i + 1];
        bounds[order[i]] = {
            from: left[order[i]],
            to: next !== undefined ? left[next] : Math.min(...Object.values(right)) - 40,
        };
    }
    return { bounds, right, left };
}

/** The amount column a right-aligned number belongs to: the one its right edge lands nearest. */
function amountColumn(rightEdges, right) {
    const keys = Object.keys(rightEdges);
    if (!keys.length) return null;
    return keys.reduce((best, k) => (Math.abs(rightEdges[k] - right) < Math.abs(rightEdges[best] - right) ? k : best), keys[0]);
}

/**
 * Which column a fragment is in: the last one whose start it has reached.
 *
 * The slack is there for the strips that begin with a space and are printed that much further
 * left — they still belong to the column they hang off the edge of.
 */
function bandOf(starts, x) {
    let found = starts[0].key;
    for (const s of starts) if (x >= s.at - 8) found = s.key;
    return found;
}

/**
 * One printed line, split into what it says in each column.
 *
 * Narration pieces keep their left edge, because the gap between a strip's edge and the column's
 * is what says how many spaces the strip began with.
 */
function readLine(rightEdges, bounds, starts, line) {
    const out = { narration: [], ref: [], amounts: [], dates: [] };
    const amountsBegin = (bounds.value_date?.from ?? bounds.ref?.from ?? 0) + 10;
    for (const p of line.parts) {
        const text = p.text.trim();
        if (!text) continue;

        // Right of the last text column, a figure with paise is an amount. Inside the narration,
        // the same digits are part of what the bank wrote.
        if (AMOUNT.test(text) && p.x > amountsBegin) {
            out.amounts.push({ col: amountColumn(rightEdges, p.x + p.w), value: num(text), right: p.x + p.w });
            continue;
        }
        const key = bandOf(starts, p.x);
        if (key === 'date' || key === 'value_date') {
            if (DATE.test(text)) out.dates.push({ key, value: toDate(text) });
            continue;   // anything else out there is page furniture
        }
        if (key === 'narration') out.narration.push({ text: p.text, x: p.x });
        else if (key === 'ref') out.ref.push(text);
    }
    return out;
}

/**
 * Put a wrapped narration back together.
 *
 * Each strip is placed at the column's left edge; one printed a space-width further left began
 * with that many spaces, which is the only record left of a gap the wrap fell on.
 */
function joinNarration(pieces, columnLeft, spaceWidth) {
    let out = '';
    for (const p of pieces) {
        const shift = columnLeft - p.x;
        const spaces = shift > spaceWidth * 0.5 ? Math.round(shift / spaceWidth) : 0;
        out += ' '.repeat(Math.min(spaces, 4)) + p.text.replace(/\s+$/, '');
    }
    return clean(out);
}

/**
 * How wide one character is in the narration, measured from the document rather than assumed.
 *
 * It is the unit a strip's shift is counted in, so it is taken as the median width-per-character
 * of the long strips — the ones wide enough that one odd glyph cannot skew them.
 */
function charWidthOf(pages, bounds) {
    const widths = [];
    for (const page of pages) {
        for (const line of page.lines) {
            for (const p of line.parts) {
                if (!bounds.narration || p.x < bounds.narration.from - 8 || p.x >= bounds.narration.to - 6) continue;
                const len = p.text.trim().length;
                if (len >= 12 && p.w > 0) widths.push(p.w / len);
            }
        }
    }
    if (!widths.length) return 4.3;   // 9pt Arial, which is what these statements are set in
    widths.sort((a, b) => a - b);
    return widths[Math.floor(widths.length / 2)];
}

/**
 * Where the table starts on a page.
 *
 * Only the first page carries the column headings; every page after it repeats the letterhead and
 * then simply carries on. What every page does have is the line naming the period, which is the
 * last thing printed before the table — so that is the floor, and on page one the headings
 * themselves sit just below it.
 */
const PERIOD_LINE = /(statement of account|^from\s*:\s*\d)/i;
function bodyTopOf(page) {
    const marks = page.lines.filter(l => PERIOD_LINE.test(l.text) || findHeader([l]));
    if (!marks.length) return null;
    return Math.min(...marks.map(m => m.y));
}

/** Every transaction in the document, in the order it was printed. */
function parseTransactions(pages) {
    const first = pages.map(p => findHeader(p.lines)).find(Boolean);
    if (!first) return { columns: null, rows: [] };

    const columns = first.columns;
    const measured = measureColumns(pages, first);
    if (!measured) return { columns, rows: [] };
    const { bounds, right: rightEdges, left } = measured;
    // The column starts, in order, which is all the band test needs.
    const starts = Object.entries(left).map(([key, at]) => ({ key, at })).sort((a, b) => a.at - b.at);
    const narrationLeft = bounds.narration?.from ?? 0;
    const spaceWidth = charWidthOf(pages, bounds);
    const rows = [];
    let open = null;                       // the row whose narration may still be continued

    const close = () => {
        if (!open) return;
        open.narration = joinNarration(open.pieces, open.narrationLeft, spaceWidth);
        delete open.pieces; delete open.narrationLeft;
        rows.push(open);
        open = null;
    };

    for (const page of pages) {
        const top = bodyTopOf(page);
        // Everything above that is the letterhead, which is reprinted on every page.
        const body = top === null ? [] : page.lines.filter(l => l.y < top - 2);
        for (const line of body) {
            if (END_OF_TABLE.test(line.text)) { close(); return { columns, rows }; }

            const cells = readLine(rightEdges, bounds, starts, line);
            const date = cells.dates.find(d => d.key === 'date')?.value || null;

            if (date) {
                close();
                const balance = cells.amounts.find(a => a.col === 'balance');
                const debit = cells.amounts.find(a => a.col === 'debit');
                const credit = cells.amounts.find(a => a.col === 'credit');
                // The strip that starts the narration sets the column's true left edge; later
                // strips are measured against it.
                const left = cells.narration.length ? Math.max(narrationLeft, Math.min(...cells.narration.map(p => p.x))) : narrationLeft;
                open = {
                    txn_date: date,
                    value_date: cells.dates.find(d => d.key === 'value_date')?.value || null,
                    ref_no: cells.ref.join(' ').trim() || null,
                    debit: debit?.value || 0,
                    credit: credit?.value || 0,
                    balance: balance ? balance.value : null,
                    row_no: rows.length + 1,
                    pieces: cells.narration,
                    narrationLeft: left,
                };
                continue;
            }

            // No date of its own: a strip of the narration above, or a stray reference that wrapped.
            if (open) {
                if (cells.narration.length) open.pieces.push(...cells.narration);
                if (cells.ref.length) open.ref_no = `${open.ref_no || ''}${cells.ref.join('')}`.trim();
            }
        }
    }
    close();
    return { columns, rows };
}

/**
 * What the bank says the statement adds up to.
 *
 * Printed as a labelled block at the end — opening balance, how many debits and credits, their
 * totals, and the closing balance. It is the only independent check on a parse, so it is read
 * rather than inferred.
 */
function parseSummary(pages) {
    const lines = pages.flatMap(p => p.lines.map(l => l.text));
    const at = lines.findIndex(l => /statement summary/i.test(l));
    if (at === -1) return null;
    for (let i = at; i < Math.min(at + 6, lines.length); i++) {
        const nums = lines[i].match(/[\d,]+\.\d{2}|\b\d{1,6}\b/g);
        if (!nums || nums.length < 6) continue;
        const [opening, drCount, crCount, debits, credits, closing] = nums;
        if (!/\./.test(opening) || !/\./.test(closing)) continue;
        return {
            opening_balance: num(opening),
            dr_count: parseInt(String(drCount).replace(/\D/g, ''), 10),
            cr_count: parseInt(String(crCount).replace(/\D/g, ''), 10),
            debits: num(debits),
            credits: num(credits),
            closing_balance: num(closing),
        };
    }
    return null;
}

/**
 * Does the statement add up?
 *
 * Row by row against the printed running balance, and then the whole parse against the bank's own
 * summary. A single missed or misread line shows up as a break naming the exact rupee difference.
 */
function reconcile(rows, summary) {
    const breaks = [];
    const opening = summary?.opening_balance ?? null;
    let running = opening;

    for (const r of rows) {
        if (running === null || r.balance === null) { running = r.balance; continue; }
        const expected = Math.round((running + r.credit - r.debit) * 100) / 100;
        if (Math.abs(expected - r.balance) > 0.009) {
            breaks.push({
                row_no: r.row_no, date: r.txn_date, narration: r.narration?.slice(0, 80),
                expected, printed: r.balance, diff: Math.round((r.balance - expected) * 100) / 100,
            });
        }
        running = r.balance;
    }

    const debits = Math.round(rows.reduce((n, r) => n + (r.debit || 0), 0) * 100) / 100;
    const credits = Math.round(rows.reduce((n, r) => n + (r.credit || 0), 0) * 100) / 100;
    const drCount = rows.filter(r => r.debit > 0).length;
    const crCount = rows.filter(r => r.credit > 0).length;

    const against = summary ? {
        debits: Math.round((debits - summary.debits) * 100) / 100,
        credits: Math.round((credits - summary.credits) * 100) / 100,
        dr_count: drCount - summary.dr_count,
        cr_count: crCount - summary.cr_count,
        closing: summary.closing_balance === null || !rows.length ? null
            : Math.round((rows[rows.length - 1].balance - summary.closing_balance) * 100) / 100,
    } : null;

    const matchesBank = !against || (against.debits === 0 && against.credits === 0
        && against.dr_count === 0 && against.cr_count === 0 && against.closing === 0);

    return {
        ok: rows.length > 0 && breaks.length === 0 && matchesBank,
        breaks: breaks.slice(0, 20),
        break_count: breaks.length,
        debits, credits, dr_count: drCount, cr_count: crCount,
        against,
        opening_balance: opening ?? (rows[0] ? Math.round((rows[0].balance - rows[0].credit + rows[0].debit) * 100) / 100 : null),
        closing_balance: rows.length ? rows[rows.length - 1].balance : null,
    };
}

module.exports = { parseTransactions, parseSummary, reconcile, findHeader, toDate, num, clean };
