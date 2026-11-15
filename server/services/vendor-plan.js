/**
 * Payment plans on vendor orders: the instalments agreed (an advance, then the rest), and how far
 * the money paid so far has got through them.
 *
 * A plan is a schedule, never a gate. Payments are not matched to instalments: what is paid on the
 * order covers the instalments in order, first to last, so a payment of any size just moves the
 * line along. An instalment is due on a date, or when the order is delivered.
 *
 * Statuses: Paid · Overdue (date passed) · Due (today, or delivered) · Due soon (within a week)
 * · Upcoming · On delivery (waiting for the goods) · No date (to be fixed). `part` says some of it
 * is already paid.
 */

const { round2 } = require('./vendor-money');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOON_DAYS = 7;
const DELIVERED = 'Consignment Received';

const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const ymd = (v) => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

/**
 * Work out each instalment's position. `order` needs total, paid_amount, status.
 * Returns the instalments with amount, covered, remaining, status, part and days (to/after due).
 */
function schedule(instalments, order, today = todayIST()) {
    let left = round2(order.paid_amount);
    const delivered = order.status === DELIVERED;
    return [...(instalments || [])].sort((a, b) => a.seq - b.seq).map((i, idx, all) => {
        const amount = round2(i.amount);
        const covered = round2(Math.min(Math.max(left, 0), amount));
        left = round2(left - covered);
        const remaining = round2(amount - covered);
        const dueDate = ymd(i.due_date);
        let status, days = null;
        if (remaining <= 0) status = 'Paid';
        else if (i.due_kind === 'delivery') status = delivered ? 'Due' : 'On delivery';
        else if (!dueDate) status = 'No date';
        else {
            days = daysBetween(today, dueDate);
            status = days < 0 ? 'Overdue' : days === 0 ? 'Due' : days <= SOON_DAYS ? 'Due soon' : 'Upcoming';
        }
        return {
            id: i.id, seq: i.seq, number: idx + 1, of: all.length, label: i.label || null,
            amount, percent: i.percent != null ? Number(i.percent) : null,
            due_kind: i.due_kind, due_date: dueDate,
            covered, remaining, status, part: covered > 0 && remaining > 0, days,
        };
    });
}

/** The first instalment still owing, or null. */
const nextDue = (scheduled) => scheduled.find(i => i.status !== 'Paid') || null;

/**
 * Check a plan sent from the form against the order's total. Each row is a fixed amount or a
 * percentage, due on a date (which may be left blank, to be fixed) or on delivery.
 * Returns { error } or { rows }.
 */
function cleanPlan(input, total) {
    if (!(Number(total) > 0)) return { error: 'Give the order a total (rates or the agreed total) before setting a payment plan' };
    const rows = [];
    for (const [n, r] of (Array.isArray(input) ? input : []).entries()) {
        const percent = Number(r.percent) > 0 ? Number(r.percent) : null;
        const amount = percent ? round2(total * percent / 100) : round2(r.amount);
        if (!(amount > 0)) return { error: `Instalment ${n + 1} needs an amount or a percentage` };
        const dueKind = r.due_kind === 'delivery' ? 'delivery' : 'date';
        const dueDate = dueKind === 'date' && r.due_date ? String(r.due_date) : null;
        if (dueDate && !DATE_RE.test(dueDate)) return { error: `Instalment ${n + 1} has an invalid date` };
        rows.push({ seq: n + 1, label: String(r.label || '').trim().slice(0, 60) || null, amount, percent, due_kind: dueKind, due_date: dueDate });
    }
    if (!rows.length) return { rows };   // an empty plan clears it
    const sum = round2(rows.reduce((s, r) => s + r.amount, 0));
    // Percentages round to the paisa, so allow a rupee either way, and put the difference on the last.
    if (Math.abs(sum - total) > 1) {
        return { error: `The instalments add up to ₹${sum.toLocaleString('en-IN')} but the order total is ₹${round2(total).toLocaleString('en-IN')}` };
    }
    rows[rows.length - 1].amount = round2(rows[rows.length - 1].amount + (total - sum));
    return { rows };
}

/** Turn an order's plan into the vendor's template: shares of the total, due N days after the order. */
function toTemplate(rows, total, orderDate) {
    return rows.map(r => ({
        label: r.label,
        percent: r.percent || round2(r.amount / total * 100),
        due_kind: r.due_kind === 'delivery' ? 'delivery' : 'days',
        days: r.due_kind === 'delivery' || !r.due_date ? null : Math.max(daysBetween(orderDate, r.due_date), 0),
    }));
}

/** Turn a vendor's template into a plan for an order of this total and date. */
function fromTemplate(template, total, orderDate) {
    return (template || []).map(t => ({
        label: t.label || null,
        percent: Number(t.percent) > 0 ? Number(t.percent) : null,
        amount: Number(t.percent) > 0 ? round2(total * t.percent / 100) : round2(t.amount),
        due_kind: t.due_kind === 'delivery' ? 'delivery' : 'date',
        due_date: t.due_kind === 'delivery' || t.days == null || !orderDate ? null : addDays(orderDate, Number(t.days) || 0),
    }));
}

module.exports = { schedule, nextDue, cleanPlan, toTemplate, fromTemplate, todayIST, SOON_DAYS };
