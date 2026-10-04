/**
 * A statement, read end to end: decrypt, parse, check it adds up, and say what each line was.
 *
 * The file is handled in memory and the password never leaves this call — not to disk, not to a
 * log, not onto the statement row. What is kept is the original file exactly as the bank encrypted
 * it, under server/storage (which is not served to the web), and the transactions read out of it.
 */

const crypto = require('crypto');
const { readLines, flatten, StatementError } = require('./extract');
const { parseTransactions, reconcile, toDate, num, clean } = require('./parse');
const { categorise } = require('./categorise');

const BANKS = [
    [/hdfc\s*bank/i, 'HDFC Bank'],
    [/icici\s*bank/i, 'ICICI Bank'],
    [/axis\s*bank/i, 'Axis Bank'],
    [/state bank of india|sbi\b/i, 'State Bank of India'],
    [/kotak/i, 'Kotak Mahindra Bank'],
    [/yes\s*bank/i, 'YES Bank'],
    [/indusind/i, 'IndusInd Bank'],
    [/idfc/i, 'IDFC FIRST Bank'],
    [/federal\s*bank/i, 'Federal Bank'],
    [/canara|union bank|bank of baroda|punjab national/i, 'Public sector bank'],
];

/** What the covering letter says: whose account, which account, and over what dates. */
function readHeader(text) {
    const bank = (BANKS.find(([re]) => re.test(text)) || [])[1] || null;

    // Account numbers are printed in a dozen ways; the last four digits are what identifies the
    // account to a person, and all we need to keep.
    const acct = text.match(/account\s*(?:no\.?|number)?\s*[:\-]?\s*([0-9Xx*]{6,20})/i)
        || text.match(/\b(\d{9,18})\b/);
    const digits = acct ? String(acct[1]).replace(/\D/g, '') : '';

    // "From : 01/09/2026 To : 30/09/2026", "Statement from 01-09-2026 to 30-09-2026", or a pair
    // of dates on the same line as the word period.
    const span = text.match(/from\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s*(?:to|-|–)\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i)
        || text.match(/period\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s*(?:to|-|–)\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i);

    const opening = text.match(/opening balance\s*:?\s*([\d,]+\.?\d*)/i);
    const closing = text.match(/closing balance\s*:?\s*([\d,]+\.?\d*)/i);
    const label = text.match(/^(.{0,60}?(?:savings|current|account)[^\n]{0,40})$/im);

    return {
        bank,
        account_last4: digits ? digits.slice(-4) : null,
        account_label: label ? clean(label[1]).slice(0, 80) : null,
        period_from: span ? toDate(span[1]) : null,
        period_to: span ? toDate(span[2]) : null,
        // Only trusted as a starting figure; the running-balance check is what actually proves it.
        stated_opening: opening ? num(opening[1]) : null,
        stated_closing: closing ? num(closing[1]) : null,
    };
}

/** The same document uploaded twice is one statement, whatever it was named the second time. */
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * One line's identity, so the same transaction cannot be stored twice even when two statements
 * overlap. The balance is part of it on purpose: two identical ₹99 UPI payments on the same day
 * are two real transactions, and their running balances are what tell them apart.
 */
const fingerprint = (accountLast4, r) => crypto.createHash('sha256')
    .update([accountLast4 || '', r.txn_date, r.narration, r.ref_no || '', r.debit, r.credit, r.balance].join('|'))
    .digest('hex');

/**
 * Read a statement. Returns everything needed to store it — and, when the arithmetic does not tie
 * out, exactly which rows broke the chain, because that is what someone has to look at.
 */
async function readStatement(buffer, password, learnedRules = []) {
    const doc = await readLines(buffer, password);
    const text = flatten(doc);
    const header = readHeader(text);
    const { columns, rows } = parseTransactions(doc.pages);

    if (!columns) throw new StatementError('Could not find the transaction table in this PDF — is it a bank statement?', 'NO_TABLE');
    if (!rows.length) throw new StatementError('No transactions were found in this statement', 'NO_ROWS');

    const check = reconcile(rows, header.stated_opening);
    const transactions = rows.map(r => {
        const { category, counterparty, channel } = categorise(r.narration, { credit: r.credit }, learnedRules);
        return { ...r, category, counterparty, channel, fingerprint: fingerprint(header.account_last4, r) };
    });

    return {
        statement: {
            ...header,
            opening_balance: check.opening_balance,
            closing_balance: check.closing_balance,
            stated_debits: check.debits,
            stated_credits: check.credits,
            txn_count: transactions.length,
            reconciled: check.ok,
            reconcile_note: check.ok ? null
                : `${check.breaks.length} row${check.breaks.length === 1 ? '' : 's'} do not match the printed running balance`,
            page_count: doc.pageCount,
            // Dates are taken from the transactions when the covering letter did not state them.
            period_from: header.period_from || transactions[0].txn_date,
            period_to: header.period_to || transactions[transactions.length - 1].txn_date,
        },
        transactions,
        check,
    };
}

module.exports = { readStatement, readHeader, sha256, fingerprint, StatementError };
