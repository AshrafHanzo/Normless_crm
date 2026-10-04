/**
 * The company's money, as the bank recorded it.
 *
 * Statements are uploaded as the bank sends them — password-protected PDFs — and are read here:
 * decrypted in memory, parsed line by line, checked against the running balance the bank printed,
 * and stored as transactions. The password is used for that one call and is never stored or
 * logged. The file itself is kept under server/storage, which is not served to the web.
 *
 * Everything the page shows is derived from stored lines, never from a figure typed in: the point
 * of the module is being able to say where the money went without anyone having to be believed.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');
const bank = require('../services/bank');
const { CATEGORIES } = require('../services/bank/categorise');

const router = express.Router();

// Not under server/uploads: that directory is served statically, and a bank statement must never
// be fetchable by anyone who guesses a filename.
const STORE = path.join(__dirname, '..', 'storage', 'bank');
const MAX_MB = 15;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
        else cb(new Error('Upload the statement PDF as the bank sent it'));
    },
});

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_banking')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

const canEdit = async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_edit_banking')) {
            return res.status(403).json({ error: 'You have read-only access to the bank statements' });
        }
        next();
    } catch (err) { next(err); }
};

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/** The rules the team has taught it, newest first so a recent correction wins. */
const learnedRules = async () =>
    (await db.query('SELECT match, category, counterparty FROM bank_rules ORDER BY created_at DESC')).rows;

/* ── Uploading ──────────────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/banking/statements — upload one statement.
 *
 * `password` is read, used, and dropped. `preview` parses and reports without storing anything,
 * which is how the page shows what it found before it is committed.
 */
router.post('/statements', canEdit, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Attach the statement PDF' });
        const password = String(req.body?.password || '');
        const preview = String(req.body?.preview || '') === 'true';

        const sha = bank.sha256(req.file.buffer);
        const seen = (await db.query('SELECT id, file_name, period_from, period_to FROM bank_statements WHERE file_sha256 = $1', [sha])).rows[0];
        if (seen && !preview) {
            return res.status(409).json({
                error: `That exact statement is already loaded (uploaded as ${seen.file_name})`,
                statement_id: seen.id, duplicate: true,
            });
        }

        const read = await bank.readStatement(req.file.buffer, password, await learnedRules());
        if (preview) {
            return res.json({
                preview: true, duplicate: !!seen,
                statement: read.statement,
                check: read.check,
                sample: read.transactions.slice(0, 8),
            });
        }

        fs.mkdirSync(STORE, { recursive: true });
        const safeName = `${Date.now()}-${sha.slice(0, 10)}.pdf`;
        fs.writeFileSync(path.join(STORE, safeName), req.file.buffer);

        const s = read.statement;
        const saved = await db.transaction(async (tx) => {
            const row = (await tx.query(
                `INSERT INTO bank_statements
                   (bank, account_label, account_last4, period_from, period_to, opening_balance,
                    closing_balance, stated_debits, stated_credits, txn_count, reconciled,
                    reconcile_note, file_name, file_path, file_sha256, page_count, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                 RETURNING *`,
                [s.bank, s.account_label, s.account_last4, s.period_from, s.period_to, s.opening_balance,
                    s.closing_balance, s.stated_debits, s.stated_credits, s.txn_count, s.reconciled,
                    s.reconcile_note, req.file.originalname, safeName, sha, s.page_count, req.user?.username || null])).rows[0];

            // Lines already held from an overlapping statement are skipped, not duplicated — the
            // fingerprint is what decides, so a month uploaded twice adds nothing the second time.
            let added = 0;
            for (const t of read.transactions) {
                const r = await tx.query(
                    `INSERT INTO bank_transactions
                       (statement_id, account_last4, txn_date, value_date, narration, ref_no, debit,
                        credit, balance, category, counterparty, channel, row_no, fingerprint)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                     ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
                    [row.id, s.account_last4, t.txn_date, t.value_date, t.narration, t.ref_no, t.debit,
                        t.credit, t.balance, t.category, t.counterparty, t.channel, t.row_no, t.fingerprint]);
                if (r.rows[0]) added++;
            }
            return { ...row, added, skipped: read.transactions.length - added };
        });

        res.status(201).json({ statement: saved, check: read.check });
    } catch (err) {
        if (err?.code === 'PASSWORD' || err?.code === 'NOT_PDF' || err?.code === 'NO_TABLE' || err?.code === 'NO_ROWS') {
            return res.status(400).json({ error: err.message, code: err.code });
        }
        if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `The file must be under ${MAX_MB}MB` });
        console.error('bank upload error:', err);
        res.status(500).json({ error: 'Could not read that statement' });
    }
});

/* ── Reading ────────────────────────────────────────────────────────────────────────────────── */

/** Which periods are loaded, and whether each one tied out. */
router.get('/statements', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, bank, account_label, account_last4,
                    TO_CHAR(period_from,'YYYY-MM-DD') AS period_from,
                    TO_CHAR(period_to,'YYYY-MM-DD') AS period_to,
                    opening_balance, closing_balance, stated_debits, stated_credits, txn_count,
                    reconciled, reconcile_note, file_name, page_count, uploaded_by, uploaded_at
               FROM bank_statements ORDER BY period_from DESC NULLS LAST, id DESC`);
        res.json({ statements: r.rows });
    } catch (err) {
        console.error('bank statements error:', err);
        res.status(500).json({ error: 'Could not read the statements' });
    }
});

/** The vocabulary and what is actually in use, for the filters. */
router.get('/options', async (req, res) => {
    try {
        const used = await db.query(
            `SELECT DISTINCT category FROM bank_transactions WHERE category IS NOT NULL ORDER BY category`);
        const accounts = await db.query(
            `SELECT DISTINCT account_last4 FROM bank_transactions WHERE account_last4 IS NOT NULL ORDER BY account_last4`);
        const span = await db.query(
            `SELECT TO_CHAR(MIN(txn_date),'YYYY-MM-DD') AS first, TO_CHAR(MAX(txn_date),'YYYY-MM-DD') AS last
               FROM bank_transactions`);
        res.json({
            categories: CATEGORIES,
            inUse: used.rows.map(r => r.category),
            accounts: accounts.rows.map(r => r.account_last4),
            span: span.rows[0],
        });
    } catch (err) {
        console.error('bank options error:', err);
        res.status(500).json({ error: 'Could not read the filters' });
    }
});

/** The filters every list and figure on the page share. */
function scope(query) {
    const where = [];
    const vals = [];
    if (isDate(query.from)) { vals.push(query.from); where.push(`txn_date >= $${vals.length}`); }
    if (isDate(query.to)) { vals.push(query.to); where.push(`txn_date <= $${vals.length}`); }
    if (trim(query.account)) { vals.push(trim(query.account)); where.push(`account_last4 = $${vals.length}`); }
    if (trim(query.category)) { vals.push(trim(query.category)); where.push(`category = $${vals.length}`); }
    if (trim(query.channel)) { vals.push(trim(query.channel)); where.push(`channel = $${vals.length}`); }
    if (trim(query.direction) === 'in') where.push('credit > 0');
    if (trim(query.direction) === 'out') where.push('debit > 0');
    if (trim(query.search)) {
        vals.push(`%${trim(query.search)}%`);
        const i = vals.length;
        where.push(`(narration ILIKE $${i} OR counterparty ILIKE $${i} OR ref_no ILIKE $${i} OR note ILIKE $${i})`);
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', vals };
}

const TXN_SORTS = {
    txn_date: 'txn_date', narration: 'LOWER(narration)', counterparty: 'LOWER(counterparty)',
    debit: 'debit', credit: 'credit', balance: 'balance', category: 'category',
};

/** Every line in the chosen period — this is the list that must miss nothing. */
router.get('/transactions', async (req, res) => {
    try {
        const { clause, vals } = scope(req.query);
        const t = tableParams(req.query, { sortable: TXN_SORTS, defaultSort: 'txn_date', defaultDir: 'desc', defaultLimit: 50, maxLimit: 500 });
        const rows = (await db.query(
            `SELECT id, statement_id, account_last4, TO_CHAR(txn_date,'YYYY-MM-DD') AS txn_date,
                    TO_CHAR(value_date,'YYYY-MM-DD') AS value_date, narration, ref_no, debit, credit,
                    balance, category, counterparty, channel, note, categorised_by
               FROM bank_transactions ${clause} ${t.orderBy}, row_no DESC LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;
        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM bank_transactions ${clause}`, vals)).rows[0].n;
        const sums = (await db.query(
            `SELECT COALESCE(SUM(credit),0) AS credits, COALESCE(SUM(debit),0) AS debits
               FROM bank_transactions ${clause}`, vals)).rows[0];
        res.json({
            transactions: rows,
            totals: { credits: money(sums.credits), debits: money(sums.debits), net: money(sums.credits - sums.debits) },
            pagination: pagination(total, t),
        });
    } catch (err) {
        console.error('bank transactions error:', err);
        res.status(500).json({ error: 'Could not read the transactions' });
    }
});

/**
 * GET /api/banking/summary — the overall view.
 *
 * In, out, and where the out went, for whatever window is being looked at, plus the month by month
 * shape of it so a period can be compared with the one before.
 */
router.get('/summary', async (req, res) => {
    try {
        const { clause, vals } = scope(req.query);
        const totals = (await db.query(
            `SELECT COALESCE(SUM(credit),0) AS credits, COALESCE(SUM(debit),0) AS debits,
                    COUNT(*)::int AS txns,
                    COUNT(*) FILTER (WHERE category = 'Uncategorised')::int AS uncategorised,
                    TO_CHAR(MIN(txn_date),'YYYY-MM-DD') AS first, TO_CHAR(MAX(txn_date),'YYYY-MM-DD') AS last
               FROM bank_transactions ${clause}`, vals)).rows[0];

        const byCategory = (await db.query(
            `SELECT category,
                    COALESCE(SUM(debit),0) AS out, COALESCE(SUM(credit),0) AS in,
                    COUNT(*)::int AS txns
               FROM bank_transactions ${clause}
              GROUP BY category ORDER BY SUM(debit) DESC NULLS LAST`, vals)).rows;

        const byMonth = (await db.query(
            `SELECT TO_CHAR(DATE_TRUNC('month', txn_date),'YYYY-MM') AS month,
                    COALESCE(SUM(credit),0) AS in, COALESCE(SUM(debit),0) AS out, COUNT(*)::int AS txns
               FROM bank_transactions ${clause}
              GROUP BY 1 ORDER BY 1`, vals)).rows;

        const topOut = (await db.query(
            `SELECT COALESCE(counterparty, 'Not named') AS counterparty, category,
                    COALESCE(SUM(debit),0) AS out, COUNT(*)::int AS txns
               FROM bank_transactions ${clause} ${clause ? 'AND' : 'WHERE'} debit > 0
              GROUP BY 1, 2 ORDER BY SUM(debit) DESC LIMIT 15`, vals)).rows;

        const topIn = (await db.query(
            `SELECT COALESCE(counterparty, 'Not named') AS counterparty, category,
                    COALESCE(SUM(credit),0) AS in, COUNT(*)::int AS txns
               FROM bank_transactions ${clause} ${clause ? 'AND' : 'WHERE'} credit > 0
              GROUP BY 1, 2 ORDER BY SUM(credit) DESC LIMIT 15`, vals)).rows;

        // What the account actually stood at, either end of the window.
        const ends = (await db.query(
            `SELECT (SELECT balance FROM bank_transactions ${clause} ORDER BY txn_date ASC, row_no ASC LIMIT 1) AS opening_after_first,
                    (SELECT balance FROM bank_transactions ${clause} ORDER BY txn_date DESC, row_no DESC LIMIT 1) AS closing`, vals)).rows[0];

        res.json({
            totals: {
                credits: money(totals.credits), debits: money(totals.debits),
                net: money(totals.credits - totals.debits),
                txns: totals.txns, uncategorised: totals.uncategorised,
                first: totals.first, last: totals.last,
                closing_balance: ends.closing === null ? null : money(ends.closing),
            },
            byCategory: byCategory.map(r => ({ ...r, out: money(r.out), in: money(r.in) })),
            byMonth: byMonth.map(r => ({ ...r, in: money(r.in), out: money(r.out), net: money(r.in - r.out) })),
            topOut: topOut.map(r => ({ ...r, out: money(r.out) })),
            topIn: topIn.map(r => ({ ...r, in: money(r.in) })),
        });
    } catch (err) {
        console.error('bank summary error:', err);
        res.status(500).json({ error: 'Could not work out the summary' });
    }
});

/* ── Correcting ─────────────────────────────────────────────────────────────────────────────── */

/**
 * PATCH /api/banking/transactions/:id — say what a line really was.
 *
 * Amounts and dates are not editable: they are what the bank recorded, and the whole report rests
 * on them being untouched. What can be changed is what it meant.
 */
router.patch('/transactions/:id', canEdit, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10) || 0;
        const row = (await db.query('SELECT id, narration FROM bank_transactions WHERE id = $1', [id])).rows[0];
        if (!row) return res.status(404).json({ error: 'That transaction is gone' });

        const patch = {};
        if (req.body.category !== undefined) patch.category = trim(req.body.category) || 'Uncategorised';
        if (req.body.counterparty !== undefined) patch.counterparty = trim(req.body.counterparty);
        if (req.body.note !== undefined) patch.note = trim(req.body.note);
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
        patch.categorised_by = req.user?.username || null;

        const cols = Object.keys(patch);
        await db.query(
            `UPDATE bank_transactions SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`, [id, ...cols.map(c => patch[c])]);

        // Teach it, if asked: the phrase picked out of this narration becomes a rule, and every
        // other line carrying it is brought into line at the same time.
        let applied = 0;
        const learn = trim(req.body.learn_match);
        if (learn && patch.category) {
            await db.query(
                `INSERT INTO bank_rules (match, category, counterparty, created_by) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (LOWER(match)) DO UPDATE SET category = EXCLUDED.category, counterparty = EXCLUDED.counterparty`,
                [learn, patch.category, patch.counterparty || null, req.user?.username || null]);
            const r = await db.query(
                `UPDATE bank_transactions SET category = $2, counterparty = COALESCE($3, counterparty),
                        categorised_by = $4, updated_at = CURRENT_TIMESTAMP
                  WHERE narration ILIKE $1 RETURNING id`,
                [`%${learn}%`, patch.category, patch.counterparty || null, req.user?.username || null]);
            applied = r.rows.length;
        }

        const saved = (await db.query(
            `SELECT id, TO_CHAR(txn_date,'YYYY-MM-DD') AS txn_date, narration, debit, credit, balance,
                    category, counterparty, channel, note, categorised_by
               FROM bank_transactions WHERE id = $1`, [id])).rows[0];
        res.json({ transaction: saved, applied });
    } catch (err) {
        console.error('bank categorise error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

/** Only the owner removes a statement, and its transactions go with it. */
router.delete('/statements/:id', canEdit, async (req, res) => {
    try {
        if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove a statement' });
        const id = parseInt(req.params.id, 10) || 0;
        const row = (await db.query('SELECT file_path, file_name FROM bank_statements WHERE id = $1', [id])).rows[0];
        if (!row) return res.status(404).json({ error: 'That statement is already gone' });
        const n = (await db.query('DELETE FROM bank_transactions WHERE statement_id = $1 RETURNING id', [id])).rows.length;
        await db.query('DELETE FROM bank_statements WHERE id = $1', [id]);
        try { fs.unlinkSync(path.join(STORE, row.file_path)); } catch { /* the row is what matters */ }
        res.json({ deleted: true, transactions: n, file_name: row.file_name });
    } catch (err) {
        console.error('bank delete error:', err);
        res.status(500).json({ error: 'Could not remove that statement' });
    }
});

module.exports = router;
