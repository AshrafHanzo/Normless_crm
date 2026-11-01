/**
 * Payroll arithmetic: the settings, what a month of leave costs each person, the monthly run, the
 * payslip PDF and the bank file.
 *
 * Salary is one monthly amount paid in full (the business has no PF/ESI today). Loss of pay comes
 * from leave beyond the paid allowance, absences a lead marks, permission hours over the monthly
 * allowance, and days before joining or after leaving. All dates are calendar dates (YYYY-MM-DD)
 * handled as UTC midnights, so no time zone moves a day.
 */

const db = require('../db/connection');

const DEFAULTS = {
    // How one day's pay is worked out: 'thirty' = salary ÷ 30, 'month' = ÷ days in the month,
    // 'working' = ÷ working days (no Sundays or holidays).
    day_basis: 'thirty',
    paid_leave_per_month: 1,
    carry_max: 6,
    permission_hours: 3,
    // Over the allowance, every this many hours is half a day's loss of pay.
    permission_block_hours: 4,
    lop: { beyond_balance: true, absent: true, sandwich: false, first_month: false },
    // Leave balances are counted from this month on (the month payroll started in the CRM).
    leave_from: null,
    pay_day: 1,
    companies: {
        normless: { name: 'Normless', address: '' },
        crewfit: { name: 'Crewfit Fashion', address: 'Plot no 2, 2nd Floor, Dhanalakshmi Nagar, Moulivakkam, Iyyappanthangal, Chennai, Tamil Nadu 600125' },
    },
};

async function getSettings() {
    const row = (await db.query(`SELECT value FROM team_settings WHERE key = 'payroll'`)).rows[0];
    const v = row?.value || {};
    const s = { ...DEFAULTS, ...v, lop: { ...DEFAULTS.lop, ...(v.lop || {}) }, companies: { ...DEFAULTS.companies, ...(v.companies || {}) } };
    if (!s.leave_from) {
        // First read: balances start this month, and that is saved so it never moves.
        const d = new Date();
        s.leave_from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        await saveSettings(s, 'system');
    }
    return s;
}

async function saveSettings(next, username) {
    await db.query(
        `INSERT INTO team_settings (key, value, updated_by) VALUES ('payroll', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [JSON.stringify(next), username || null]);
}

/* ── dates ── */
const D = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const monthStart = (s) => `${String(s).slice(0, 7)}-01`;
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return ymd(d); };
const nextMonth = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); return ymd(d); };
const daysIn = (s) => Number(monthEnd(s).slice(8, 10));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (s) => `${MONTHS[Number(String(s).slice(5, 7)) - 1]} ${String(s).slice(0, 4)}`;
const round = (n) => Math.round(Number(n) || 0);

async function holidaysIn(from, to) {
    const r = await db.query(`SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day FROM team_holidays WHERE day BETWEEN $1 AND $2`, [from, to]);
    return new Set(r.rows.map(x => x.day));
}
const isOff = (day, holidays) => D(day).getUTCDay() === 0 || holidays.has(day);

function workingDays(month, holidays) {
    let n = 0;
    for (let d = D(monthStart(month)); ymd(d) <= monthEnd(month); d = addDays(d, 1)) if (!isOff(ymd(d), holidays)) n++;
    return n;
}

function dayRate(salary, month, settings, holidays) {
    const div = settings.day_basis === 'month' ? daysIn(month)
        : settings.day_basis === 'working' ? Math.max(1, workingDays(month, holidays)) : 30;
    return Number(salary) / div;
}

/** The salary in force for a month: the latest revision on or before its last day. */
async function salaryFor(emp, month) {
    const r = (await db.query(
        `SELECT monthly_salary FROM team_salary_history WHERE employee_id = $1 AND effective_from <= $2
          ORDER BY effective_from DESC, id DESC LIMIT 1`, [emp.id, monthEnd(month)])).rows[0];
    return Number(r ? r.monthly_salary : emp.monthly_salary) || 0;
}

/**
 * What one month of leave comes to for one person, given the paid balance they start it with.
 * Returns { leaveDays, paidDays, lopDays, permissionHours, breakdown[], balanceAfter }.
 */
function monthLeave(emp, month, leaves, holidays, settings, openingBalance) {
    const from = monthStart(month), to = monthEnd(month);
    const leaveDay = new Map();      // day → fraction taken as leave
    const absentDay = new Map();     // day → fraction marked absent
    let permissionHours = 0;
    const breakdown = [];

    for (const l of leaves) {
        if (l.status !== 'approved') continue;
        if (l.kind === 'permission') {
            if (l.from_date >= from && l.from_date <= to) {
                permissionHours += Number(l.hours) || 0;
                breakdown.push({ kind: 'permission', day: l.from_date, hours: Number(l.hours) || 0 });
            }
            continue;
        }
        const target = l.kind === 'absent' ? absentDay : leaveDay;
        const portion = l.kind === 'half' ? 0.5 : 1;
        for (let d = D(l.from_date); ymd(d) <= l.to_date; d = addDays(d, 1)) {
            const day = ymd(d);
            if (day < from || day > to || isOff(day, holidays)) continue;
            target.set(day, Math.min(1, (target.get(day) || 0) + portion));
        }
    }
    // A Sunday or holiday with leave on both sides counts as leave too, if that rule is on.
    if (settings.lop.sandwich) {
        for (let d = D(from); ymd(d) <= to; d = addDays(d, 1)) {
            const day = ymd(d);
            if (!isOff(day, holidays)) continue;
            const before = ymd(addDays(d, -1)), after = ymd(addDays(d, 1));
            const taken = (x) => (leaveDay.get(x) || 0) + (absentDay.get(x) || 0) >= 1;
            if (taken(before) && taken(after)) leaveDay.set(day, 1);
        }
    }

    const leaveDays = [...leaveDay.values()].reduce((a, b) => a + b, 0);
    const absentDays = [...absentDay.values()].reduce((a, b) => a + b, 0);
    for (const [day, n] of leaveDay) breakdown.push({ kind: 'leave', day, days: n });
    for (const [day, n] of absentDay) breakdown.push({ kind: 'absent', day, days: n });

    const firstMonth = settings.lop.first_month && emp.joined_on && monthStart(emp.joined_on) === from;
    const allowance = firstMonth ? 0 : Number(emp.paid_leave_per_month ?? settings.paid_leave_per_month) || 0;
    const balance = openingBalance + allowance;
    const paidDays = settings.lop.beyond_balance ? Math.min(balance, leaveDays) : leaveDays;
    let lopDays = leaveDays - paidDays;
    // An absence the lead marked counts as loss of pay; with that rule off it uses the balance like leave.
    if (settings.lop.absent) lopDays += absentDays;
    else {
        const fromBalance = Math.min(Math.max(0, balance - paidDays), absentDays);
        lopDays += absentDays - fromBalance;
    }
    const extraHours = Math.max(0, permissionHours - (Number(settings.permission_hours) || 0));
    const block = Number(settings.permission_block_hours) || 4;
    const permissionLop = Math.floor(extraHours / block) * 0.5;
    lopDays += permissionLop;

    const used = Math.min(balance, paidDays + (settings.lop.absent ? 0 : absentDays));
    const balanceAfter = Math.min(Math.max(0, balance - used), Number(settings.carry_max) || 0);
    breakdown.sort((a, b) => a.day.localeCompare(b.day));
    return { leaveDays, absentDays, paidDays, lopDays, permissionHours, permissionLop, allowance, balanceAfter, breakdown };
}

/** Days in the month before joining or after leaving, counted the way a day's pay is. */
function notEmployedDays(emp, month, settings, holidays) {
    const from = monthStart(month), to = monthEnd(month);
    let n = 0;
    for (let d = D(from); ymd(d) <= to; d = addDays(d, 1)) {
        const day = ymd(d);
        const out = (emp.joined_on && day < emp.joined_on) || (emp.left_on && day > emp.left_on);
        if (!out) continue;
        if (settings.day_basis === 'working' && isOff(day, holidays)) continue;
        n++;
    }
    // On a ÷30 basis a 31-day month still holds 30 paid days.
    if (settings.day_basis === 'thirty') n = Math.min(n, 30);
    return n;
}

async function leavesOf(empId, from, to) {
    return (await db.query(
        `SELECT kind, TO_CHAR(from_date, 'YYYY-MM-DD') AS from_date, TO_CHAR(to_date, 'YYYY-MM-DD') AS to_date,
                hours, status FROM team_leave
          WHERE employee_id = $1 AND to_date >= $2 AND from_date <= $3`, [empId, from, to])).rows;
}

/**
 * A person's leave month by month from the start of balances to `month`, carrying the balance
 * forward. Returns that month's figures plus its opening balance.
 */
async function leaveForMonth(emp, month, settings) {
    const start = [settings.leave_from, emp.joined_on ? monthStart(emp.joined_on) : null].filter(Boolean).sort().pop();
    const target = monthStart(month);
    const holidays = await holidaysIn(start < target ? start : target, monthEnd(target));
    const leaves = await leavesOf(emp.id, start < target ? start : target, monthEnd(target));
    let balance = 0;
    let m = start < target ? start : target;
    let out = null;
    while (m <= target) {
        out = monthLeave(emp, m, leaves, holidays, settings, balance);
        out.opening = balance;
        balance = out.balanceAfter;
        m = nextMonth(m);
    }
    return { ...out, holidays };
}

/** Paid leave left right now, for the person's own page and the request form. */
async function balanceNow(emp) {
    const settings = await getSettings();
    const d = new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const r = await leaveForMonth(emp, month, settings);
    const leftThisMonth = Math.max(0, r.opening + r.allowance - r.paidDays);
    return {
        paidLeft: leftThisMonth, allowance: r.allowance, permissionUsed: r.permissionHours,
        permissionAllowed: Number(settings.permission_hours) || 0, lopDays: r.lopDays,
    };
}

/** One person's line for a month. */
async function computeLine(emp, month, settings) {
    const salary = await salaryFor(emp, month);
    const leave = await leaveForMonth(emp, month, settings);
    const rate = dayRate(salary, month, settings, leave.holidays);
    const outDays = notEmployedDays(emp, month, settings, leave.holidays);
    const lopDays = leave.lopDays + outDays;
    const lopAmount = Math.min(salary, round(rate * lopDays));

    const claims = (await db.query(
        `SELECT id, title, amount FROM team_claims
          WHERE employee_id = $1 AND status = 'approved' AND with_salary AND paid_run_id IS NULL`, [emp.id])).rows;
    const claimsTotal = claims.reduce((a, c) => a + Number(c.amount), 0);

    // Advances: what is still owed, taken back at the agreed monthly amount.
    const adv = (await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS given, COALESCE(SUM(recover_per_month), 0) AS per_month
           FROM team_advances WHERE employee_id = $1 AND given_on <= $2`, [emp.id, monthEnd(month)])).rows[0];
    const back = (await db.query(
        `SELECT COALESCE(SUM(l.advance_back), 0) AS n FROM team_pay_lines l JOIN team_pay_runs r ON r.id = l.run_id
          WHERE l.employee_id = $1 AND r.status <> 'draft' AND r.month < $2`, [emp.id, monthStart(month)])).rows[0];
    const owed = Math.max(0, Number(adv.given) - Number(back.n));
    const advanceBack = round(Math.min(owed, Number(adv.per_month)));

    return {
        salary: round(salary), day_rate: Math.round(rate * 100) / 100,
        paid_leave_days: leave.paidDays, lop_days: lopDays, lop_amount: lopAmount,
        claims: round(claimsTotal), advance_back: advanceBack,
        pay_to: emp.bank_account ? `${emp.bank_name || 'Bank'} ····${String(emp.bank_account).slice(-4)}` : (emp.upi_id ? `UPI ${emp.upi_id}` : null),
        detail: {
            leave: leave.breakdown, opening_balance: leave.opening, allowance: leave.allowance,
            leave_days: leave.leaveDays, absent_days: leave.absentDays, permission_hours: leave.permissionHours,
            permission_lop: leave.permissionLop, not_employed_days: outDays, balance_after: leave.balanceAfter,
            claim_ids: claims.map(c => c.id), claims: claims.map(c => ({ title: c.title, amount: Number(c.amount) })),
            advance_owed: owed,
        },
    };
}

const netOf = (l) => round(Number(l.salary) - Number(l.lop_amount) + Number(l.incentive || 0) + Number(l.claims) - Number(l.advance_back));

/** Who is paid for a month: active or on notice, joined by its end, not left before its start. */
async function payableEmployees(month) {
    return (await db.query(
        `SELECT *, TO_CHAR(joined_on, 'YYYY-MM-DD') AS joined_on, TO_CHAR(left_on, 'YYYY-MM-DD') AS left_on
           FROM team_employees
          WHERE (joined_on IS NULL OR joined_on <= $2) AND (left_on IS NULL OR left_on >= $1)
            AND (status <> 'left' OR (left_on IS NOT NULL AND left_on >= $1))
          ORDER BY name`, [monthStart(month), monthEnd(month)])).rows;
}

/**
 * (Re)work out every line of a draft run. Incentives typed in are kept; everything else is
 * recalculated, so an approved leave or a new claim shows up the next time the run is opened.
 */
async function refreshRun(runId) {
    const run = (await db.query(`SELECT id, TO_CHAR(month, 'YYYY-MM-DD') AS month, status FROM team_pay_runs WHERE id = $1`, [runId])).rows[0];
    if (!run || run.status !== 'draft') return run;
    const settings = await getSettings();
    const emps = await payableEmployees(run.month);
    const keep = new Map((await db.query('SELECT employee_id, incentive, incentive_note FROM team_pay_lines WHERE run_id = $1', [runId])).rows
        .map(r => [r.employee_id, r]));
    await db.query('DELETE FROM team_pay_lines WHERE run_id = $1 AND NOT (employee_id = ANY($2))', [runId, emps.map(e => e.id)]);
    for (const emp of emps) {
        const line = await computeLine(emp, run.month, settings);
        const incentive = Number(keep.get(emp.id)?.incentive || 0);
        const net = netOf({ ...line, incentive });
        await db.query(
            `INSERT INTO team_pay_lines (run_id, employee_id, salary, day_rate, paid_leave_days, lop_days, lop_amount,
                 incentive, incentive_note, claims, advance_back, net, pay_to, detail)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (run_id, employee_id) DO UPDATE SET salary = EXCLUDED.salary, day_rate = EXCLUDED.day_rate,
                 paid_leave_days = EXCLUDED.paid_leave_days, lop_days = EXCLUDED.lop_days, lop_amount = EXCLUDED.lop_amount,
                 claims = EXCLUDED.claims, advance_back = EXCLUDED.advance_back, net = EXCLUDED.net,
                 pay_to = EXCLUDED.pay_to, detail = EXCLUDED.detail`,
            [runId, emp.id, line.salary, line.day_rate, line.paid_leave_days, line.lop_days, line.lop_amount,
             incentive, keep.get(emp.id)?.incentive_note || null, line.claims, line.advance_back, net, line.pay_to,
             JSON.stringify(line.detail)]);
    }
    return run;
}

/* ── payslip PDF ── */
const inr = (n) => `Rs. ${new Intl.NumberFormat('en-IN').format(round(n))}`;

function renderPayslip(doc, { line, emp, run, settings }) {
    const co = settings.companies[emp.company === 'crewfit' ? 'crewfit' : 'normless'] || {};
    const L = 50, R = 545, W = R - L;
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a1c22').text(co.name || 'Normless', L, 50);
    doc.font('Helvetica').fontSize(9).fillColor('#4a4f5c').text(co.address || '', L, 74, { width: 300 });
    doc.font('Helvetica').fontSize(9).fillColor('#4a4f5c').text('PAYSLIP', L, 50, { width: W, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#1a1c22').text(monthName(run.month), L, 62, { width: W, align: 'right' });
    if (line.paid_at) doc.font('Helvetica').fontSize(9).fillColor('#4a4f5c').text(`Paid ${new Date(line.paid_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`, L, 82, { width: W, align: 'right' });
    doc.moveTo(L, 108).lineTo(R, 108).lineWidth(1.5).strokeColor('#1a1c22').stroke();

    const facts = [
        ['Name', emp.name], ['Employee ID', emp.emp_code || '—'],
        ['Designation', emp.designation || '—'], ['Date of joining', emp.joined_on ? D(emp.joined_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'],
        ['Bank', line.pay_to || 'Cash'], ['Paid leave · LOP days', `${Number(line.paid_leave_days)} · ${Number(line.lop_days)}`],
    ];
    let y = 122;
    facts.forEach(([k, v], i) => {
        const x = i % 2 === 0 ? L : L + W / 2 + 10;
        if (i % 2 === 0 && i) y += 18;
        doc.font('Helvetica').fontSize(9.5).fillColor('#4a4f5c').text(k, x, y);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1a1c22').text(String(v), x, y, { width: W / 2 - 10, align: 'right' });
    });

    y += 34;
    const half = W / 2;
    const earnings = [['Salary', line.salary]];
    if (Number(line.incentive)) earnings.push([line.incentive_note || 'Incentive / bonus', line.incentive]);
    for (const c of line.detail?.claims || []) earnings.push([`Reimbursement · ${c.title}`, c.amount]);
    const deductions = [[`Loss of pay (${Number(line.lop_days)} day${Number(line.lop_days) === 1 ? '' : 's'})`, line.lop_amount]];
    if (Number(line.advance_back)) deductions.push(['Salary advance', line.advance_back]);
    const rows = Math.max(earnings.length, deductions.length);
    doc.rect(L, y, W, 22).fill('#f1f2f5');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1c22').text('EARNINGS', L + 10, y + 7).text('DEDUCTIONS', L + half + 10, y + 7);
    y += 22;
    for (let i = 0; i < rows; i++) {
        const e = earnings[i], d = deductions[i];
        doc.font('Helvetica').fontSize(9.5).fillColor('#1a1c22');
        if (e) { doc.text(e[0], L + 10, y + 6, { width: half - 100 }); doc.text(inr(e[1]), L, y + 6, { width: half - 10, align: 'right' }); }
        if (d) { doc.text(d[0], L + half + 10, y + 6, { width: half - 100 }); doc.text(inr(d[1]), L + half, y + 6, { width: half - 10, align: 'right' }); }
        y += 22;
    }
    const totalE = earnings.reduce((a, e) => a + Number(e[1]), 0), totalD = deductions.reduce((a, d) => a + Number(d[1]), 0);
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.7).strokeColor('#c9ccd4').stroke();
    doc.font('Helvetica-Bold').fontSize(9.5).text('Total earnings', L + 10, y + 7).text(inr(totalE), L, y + 7, { width: half - 10, align: 'right' })
        .text('Total deductions', L + half + 10, y + 7).text(inr(totalD), L + half, y + 7, { width: half - 10, align: 'right' });
    doc.rect(L, 122 + 72, W, y + 26 - (122 + 72)).lineWidth(0.7).strokeColor('#c9ccd4').stroke();
    doc.moveTo(L + half, 122 + 72).lineTo(L + half, y + 26).stroke();
    y += 44;

    doc.rect(L, y, W, 54).fill('#1a1c22');
    doc.font('Helvetica').fontSize(9).fillColor('#c9ccd4').text('NET PAY', L + 16, y + 14);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text(inr(line.net), L, y + 16, { width: W - 16, align: 'right' });
    y += 76;

    const det = line.detail || {};
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1c22').text('LEAVE THIS MONTH', L, y);
    doc.font('Helvetica').fontSize(9.5).fillColor('#4a4f5c');
    const leaveLines = [
        `Leave taken: ${det.leave_days || 0} day(s), of which paid: ${Number(line.paid_leave_days)}`,
        `Absent: ${det.absent_days || 0} day(s) · Permission: ${det.permission_hours || 0} hour(s)`,
        `Paid leave left: ${det.balance_after ?? 0} day(s)`,
    ];
    if (det.not_employed_days) leaveLines.push(`Days before joining or after leaving: ${det.not_employed_days}`);
    leaveLines.forEach((t, i) => doc.text(t, L, y + 16 + i * 15));

    doc.font('Helvetica').fontSize(8.5).fillColor('#4a4f5c')
        .text('A computer-generated payslip; no signature is needed.', L, 770, { width: W - 140 })
        .text(`Ref PAY-${run.month.slice(0, 7)}-${String(emp.id).padStart(4, '0')}`, L, 770, { width: W, align: 'right' });
}

/** The bank's bulk-transfer sheet: one row per person with an account, as CSV. */
function bankCsv(lines, month) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const out = [['Name', 'Account number', 'IFSC', 'Bank', 'Amount', 'Narration'].map(q).join(',')];
    for (const l of lines) {
        if (!l.bank_account || Number(l.net) <= 0) continue;
        out.push([l.name, l.bank_account, l.bank_ifsc, l.bank_name, round(l.net), `Salary ${monthName(month)}`].map(q).join(','));
    }
    return out.join('\n');
}

module.exports = {
    DEFAULTS, getSettings, saveSettings, refreshRun, computeLine, netOf, payableEmployees, renderPayslip, bankCsv,
    balanceNow, leaveForMonth, monthStart, monthEnd, monthName, round, salaryFor,
};
