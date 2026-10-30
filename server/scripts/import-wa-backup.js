/**
 * Every chat from a WhatsApp Business phone backup, into the CRM at once.
 *
 * The bundle comes from scripts/wa-backup/make-bundle.py (a decrypted backup) or mac-bundle.py
 * (the WhatsApp Mac app linked to the number): chats.json + media/. Each one-to-one chat lands in
 * that customer's thread on the brand's line, the way Settings › Import chats does it: a Crewfit
 * lead is made for a new number, the messages go in in date order with their photos and files, and
 * importing again adds nothing twice.
 *
 * A chat can come with no messages — the phone labelled it or wrote a note on it, but its messages
 * stayed on the phone. It still gets its thread and lead, so the label and the notes are in the CRM,
 * and it is left closed unless its label makes it something to act on (see "open" below).
 *
 *   node scripts/import-wa-backup.js <bundle> --brand crewfit [--dry-run] [--only chats.csv] [--map labels.json]
 *
 * --map says what each WhatsApp label means here; without it a label sets the status with the same
 * name, if there is one:
 *   {
 *     "status": { "Need to follow up": "followup", "Paid": "paid", ... },   label → lead status key
 *     "order":  ["paid", "partially_paid", "important", ...],               which status wins when a chat has several
 *     "open":   ["followup", "important", ...],                             a chat without messages stays open with these
 *     "assign": { "anu": "anu@normless.store" },                            label → who the thread is assigned to
 *     "default_assign": "anu@normless.store",                               everybody else's chats, if unassigned
 *     "leave_out_only": ["Need to call", "Not picked"]                       chats with only these labels, no messages
 *                                                                            and no notes are not imported
 *   }
 * Every label is also written on the thread as a note, so the ones that map to nothing are kept.
 *
 * --dry-run reads and reports, writing nothing. --only takes the bundle's chats.csv with a yes/no
 * first column, to leave chats out. Nothing is sent to anybody.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const bundle = args[0];
const brand = flag('--brand') || 'crewfit';
const dryRun = args.includes('--dry-run');
if (!bundle || !fs.existsSync(path.join(bundle, 'chats.json'))) {
    console.error('Usage: node scripts/import-wa-backup.js <bundle folder with chats.json> --brand crewfit [--dry-run] [--map labels.json]');
    process.exit(1);
}

const db = require('../db/connection');
const lines = require('../services/wa-line');
const wa = require('../services/whatsapp');
const chatImport = require('../services/wa-chat-import');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NOTE_AUTHOR = 'WhatsApp Business app';

/** Which chats the csv says yes to, by phone; null when there is no csv. */
function chosen() {
    const file = flag('--only');
    if (!file) return null;
    const yes = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1)) {
        const [pick, phone] = line.split(',');
        if (/^\s*y/i.test(pick || '') && phone) yes.add(phone.replace(/\D/g, ''));
    }
    return yes;
}

async function main() {
    const { chats } = JSON.parse(fs.readFileSync(path.join(bundle, 'chats.json'), 'utf8'));
    const map = flag('--map') ? JSON.parse(fs.readFileSync(flag('--map'), 'utf8')) : {};
    const only = chosen();

    // Labels → lead statuses: the map first, then a status with the same name or key.
    const statuses = brand === 'crewfit' ? (await db.query('SELECT key, name, sort_order FROM wa_lead_statuses ORDER BY sort_order')).rows : [];
    const byKey = Object.fromEntries(statuses.map(s => [s.key, s]));
    const statusFor = (label) => {
        if (map.status && label in map.status) return byKey[map.status[label]] || null;
        return statuses.find(s => norm(s.name) === norm(label) || norm(s.key) === norm(label)) || null;
    };
    const rank = (s) => { const i = (map.order || []).indexOf(s.key); return i < 0 ? 1000 - s.sort_order : i; };
    const statusOf = (c) => c.labels.map(statusFor).filter(Boolean).sort((a, b) => rank(a) - rank(b))[0] || null;
    const users = new Set((await db.query('SELECT LOWER(username) AS u FROM admin_users')).rows.map(r => r.u));
    // A label naming somebody wins; otherwise whoever the map says takes the backed-up chats.
    const assignFor = (c) => c.labels.map(l => map.assign?.[l]).find(u => u && users.has(u.toLowerCase()))
        || (map.default_assign && users.has(map.default_assign.toLowerCase()) ? map.default_assign : null);
    const leaveOut = new Set(map.leave_out_only || []);
    const left = (c) => !c.messages.length && !(c.notes || []).length && c.labels.length && c.labels.every(l => leaveOut.has(l));

    const picked = chats.filter(c => (!only || only.has(c.phone)) && !left(c));
    for (const c of picked) { c.notes ??= []; c.status = statusOf(c); c.assign = assignFor(c); }

    const labels = {};
    for (const c of chats) for (const l of c.labels) {
        labels[l] ??= { chats: 0, imported: 0, status: statusFor(l)?.key || null, assign: map.assign?.[l] ? (users.has(map.assign[l].toLowerCase()) ? map.assign[l] : `${map.assign[l]} (no such user)`) : undefined };
        labels[l].chats++;
    }
    for (const c of picked) for (const l of c.labels) labels[l].imported++;

    const totals = {
        chats: picked.length, left_out: chats.length - picked.length,
        with_messages: picked.filter(c => c.messages.length).length,
        without_messages: picked.filter(c => !c.messages.length).length,
        without_messages_open: picked.filter(c => !c.messages.length && map.open?.includes(c.status?.key)).length,
        // Only labels that set nothing (call outcomes, people's names): candidates for leave_out_only.
        only_unmapped_labels: picked.filter(c => !c.messages.length && !c.notes.length && !c.status).length,
        messages: 0, files: 0, files_missing: 0, notes: 0, new_numbers: 0, existing_threads: 0,
    };
    const resulting = {};
    for (const c of picked) {
        totals.messages += c.messages.length;
        totals.files += c.messages.filter(m => m.file).length;
        totals.files_missing += c.messages.filter(m => m.missing).length;
        totals.notes += c.notes.length;
        const k = c.status?.key || '(stays as it is / enquiry)';
        resulting[k] = (resulting[k] || 0) + 1;
    }
    const assigned = {};
    for (const c of picked) if (c.assign) assigned[c.assign] = (assigned[c.assign] || 0) + 1;

    await lines.ready?.();
    const line = await lines.get(brand);
    if (!line?.id) throw new Error(`No ${brand} line in the CRM`);
    const known = new Set((await db.query('SELECT k.phone FROM wa_contacts k JOIN wa_conversations c ON c.contact_id = k.id WHERE k.line_id = $1', [line.id])).rows.map(r => r.phone));
    for (const c of picked) {
        if (known.has(wa.normalisePhone(c.phone))) totals.existing_threads++; else totals.new_numbers++;
    }
    console.log(JSON.stringify({ brand, line: line.id, dry_run: dryRun, ...totals, statuses_after: resulting, assigned, labels }, null, 1));
    if (dryRun) return;

    // --replies-only: just link the replies to the messages they quote, on chats already imported.
    // The ids are worked out exactly as the import made them, so nothing else is touched.
    if (args.includes('--replies-only')) {
        const crypto = require('crypto');
        let linked = 0;
        for (const c of picked) {
            const phone = wa.normalisePhone(c.phone);
            const id = (m) => `import:${crypto.createHash('sha1').update([line.id, phone, m.at, 'backup', m.key].join('|')).digest('hex').slice(0, 32)}`;
            const byKey = new Map(c.messages.map(m => [m.key, m]));
            for (const m of c.messages) {
                const q = m.reply_key && byKey.get(m.reply_key);
                if (!q) continue;
                const r = await db.query('UPDATE wa_messages SET reply_to = $2 WHERE wamid = $1 AND reply_to IS DISTINCT FROM $2', [id(m), id(q)]);
                linked += r.rowCount;
            }
        }
        console.log(`Linked ${linked} replies.`);
        return;
    }

    const { importChat, quietThread } = require('../routes/whatsapp');
    // As text in the database's own clock, to compare with created_at (a timestamp without zone).
    const started = (await db.query('SELECT LOCALTIMESTAMP::text AS t')).rows[0].t;
    let done = 0, failed = 0;
    for (const c of picked) {
        try {
            const phone = wa.normalisePhone(c.phone);
            const r = await lines.run(brand, async () => {
                if (c.messages.length) {
                    return importChat({
                        phone, name: c.name, actor: 'import', source: 'the WhatsApp Business app',
                        messages: c.messages.map(m => ({
                            at: m.at, inbound: !m.from_me, text: m.text, key: ['backup', m.key], replyKey: m.reply_key ? ['backup', m.reply_key] : null,
                            missing: m.missing ? m.type : null,
                            file: m.file ? { name: m.name, mime: m.mime || chatImport.mimeOf(m.name), read: () => fs.promises.readFile(path.join(bundle, m.file)) } : null,
                        })),
                    });
                }
                const thread = await quietThread(phone, c.name);
                const lead = brand === 'crewfit' ? (await db.query(
                    `SELECT l.id, l.status FROM wa_contacts k JOIN crewfit_leads l ON l.id = k.lead_id
                      WHERE k.id = (SELECT contact_id FROM wa_conversations WHERE id = $1)`, [thread.id])).rows[0] : null;
                // Nothing to read in it, so only a label worth acting on keeps it in the open inbox.
                const open = map.open?.includes(c.status?.key);
                await db.query(
                    `UPDATE wa_conversations SET status = CASE WHEN $2 THEN status ELSE 'closed' END,
                            last_message_preview = COALESCE(last_message_preview, $3)
                      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = $1)`,
                    [thread.id, !!open, `🏷 ${c.labels.join(' · ') || 'Note'} (from the WhatsApp Business app)`.slice(0, 200)]);
                return { conversation_id: thread.id, imported: 0, media: 0, lead };
            });

            // The labels and notes, as notes on the thread — once, however often this runs.
            const notes = [...(c.labels.length ? [{ text: `Labels on the WhatsApp Business app: ${c.labels.join(', ')}`, at: c.since || null }] : []), ...c.notes];
            for (const n of notes) {
                await db.query(
                    `INSERT INTO wa_notes (conversation_id, author, body, created_at)
                     SELECT $1, $2, $3, COALESCE($4::timestamp, CURRENT_TIMESTAMP)
                      WHERE NOT EXISTS (SELECT 1 FROM wa_notes WHERE conversation_id = $1 AND body = $3)`,
                    [r.conversation_id, NOTE_AUTHOR, n.text, n.at]);
            }
            // The label is the team's own judgement of the lead, so it wins over what was guessed.
            if (c.status && r.lead && r.lead.status !== c.status.key) {
                await db.query('UPDATE crewfit_leads SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [r.lead.id, c.status.key]);
                await db.query(`INSERT INTO wa_activity (conversation_id, kind, body) VALUES ($1,'status',$2)`,
                    [r.conversation_id, `Marked ${c.status.name} — its label on the WhatsApp Business app`]);
            }
            // A lead this run made is dated from when the chat began, not today, so the
            // dashboard's "new leads" counts are not swamped by the import.
            if (c.since) {
                await db.query(`UPDATE wa_conversations SET created_at = $2 WHERE id = $1 AND created_at >= $3::timestamp`, [r.conversation_id, c.since, started]);
                if (r.lead) await db.query(`UPDATE crewfit_leads SET created_at = $2 WHERE id = $1 AND created_at >= $3::timestamp`, [r.lead.id, c.since, started]);
            }
            if (c.assign) {
                await db.query('UPDATE wa_conversations SET assigned_to = $2 WHERE id = $1 AND assigned_to IS NULL', [r.conversation_id, c.assign]);
            }
            done++;
            if (c.messages.length || done % 500 === 0) {
                console.log(`${done}/${picked.length} ${c.phone} ${c.name || ''}: ${r.imported} new, ${r.media} files${c.status ? `, ${c.status.name}` : ''}`);
            }
        } catch (err) {
            failed++;
            console.error(`FAILED ${c.phone} ${c.name || ''}: ${err.message}`);
        }
    }
    console.log(`Imported ${done} chats${failed ? `, ${failed} failed` : ''}.`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
