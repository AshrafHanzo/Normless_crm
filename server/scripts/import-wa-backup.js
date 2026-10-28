/**
 * Every chat from a WhatsApp Business phone backup, into the CRM at once.
 *
 * The bundle comes from scripts/wa-backup/make-bundle.py (the decrypted backup turned into
 * chats.json + media/). Each one-to-one chat lands in that customer's thread on the brand's line,
 * the way Settings › Import chats does it: a Crewfit lead is made for a new number, the messages
 * go in in date order with their photos and files, and importing again adds nothing twice. The
 * chat's WhatsApp labels set the lead's status, by name (see --labels to map names that differ).
 *
 *   node scripts/import-wa-backup.js <bundle> --brand crewfit [--dry-run] [--only chats.csv]
 *        [--labels '{"New customer":"new","Order complete":"paid"}']
 *
 * --dry-run reads and reports, writing nothing. --only takes the bundle's chats.csv with a
 * yes/no first column, to leave chats out. Nothing is sent to anybody.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const bundle = args[0];
const brand = flag('--brand') || 'crewfit';
const dryRun = args.includes('--dry-run');
if (!bundle || !fs.existsSync(path.join(bundle, 'chats.json'))) {
    console.error('Usage: node scripts/import-wa-backup.js <bundle folder with chats.json> --brand crewfit [--dry-run]');
    process.exit(1);
}

const db = require('../db/connection');
const lines = require('../services/wa-line');
const wa = require('../services/whatsapp');
const chatImport = require('../services/wa-chat-import');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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
    const only = chosen();
    const picked = chats.filter(c => !only || only.has(c.phone));

    // Labels → lead statuses: the given map first, then a status with the same name or key.
    const statuses = brand === 'crewfit' ? (await db.query('SELECT key, name, sort_order FROM wa_lead_statuses ORDER BY sort_order')).rows : [];
    const given = JSON.parse(flag('--labels') || '{}');
    const statusFor = (label) => {
        const want = given[label] ?? label;
        return statuses.find(s => s.key === want || norm(s.name) === norm(want) || norm(s.key) === norm(want)) || null;
    };
    const labels = {};
    for (const c of picked) for (const l of c.labels) {
        labels[l] ??= { chats: 0, status: statusFor(l)?.key || null };
        labels[l].chats++;
    }

    const totals = { chats: picked.length, messages: 0, files: 0, files_missing: 0, new_numbers: 0, existing_threads: 0 };
    for (const c of picked) {
        totals.messages += c.messages.length;
        totals.files += c.messages.filter(m => m.file).length;
        totals.files_missing += c.messages.filter(m => m.missing).length;
    }
    await lines.ready?.();
    const line = await lines.get(brand);
    if (!line?.id) throw new Error(`No ${brand} line in the CRM`);
    const known = new Set((await db.query('SELECT k.phone FROM wa_contacts k JOIN wa_conversations c ON c.contact_id = k.id WHERE k.line_id = $1', [line.id])).rows.map(r => r.phone));
    for (const c of picked) {
        if (known.has(wa.normalisePhone(c.phone))) totals.existing_threads++; else totals.new_numbers++;
    }
    console.log(JSON.stringify({ brand, line: line.id, dry_run: dryRun, ...totals, labels }, null, 1));
    if (dryRun) return;

    const { importChat } = require('../routes/whatsapp');
    let done = 0, failed = 0;
    for (const c of picked) {
        try {
            const r = await lines.run(brand, () => importChat({
                phone: wa.normalisePhone(c.phone), name: c.name, actor: 'import', source: 'the WhatsApp Business phone backup',
                messages: c.messages.map(m => ({
                    at: m.at, inbound: !m.from_me, text: m.text, key: ['backup', m.key],
                    missing: m.missing ? m.type : null,
                    file: m.file ? { name: m.name, mime: m.mime || chatImport.mimeOf(m.name), read: () => fs.promises.readFile(path.join(bundle, m.file)) } : null,
                })),
            }));
            // The label is the team's own judgement of the lead, so it wins over what was guessed.
            const status = c.labels.map(statusFor).filter(Boolean).sort((a, b) => b.sort_order - a.sort_order)[0];
            if (status && r.lead && r.lead.status !== status.key) {
                await db.query('UPDATE crewfit_leads SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [r.lead.id, status.key]);
                await db.query(`INSERT INTO wa_activity (conversation_id, kind, body) VALUES ($1,'status',$2)`,
                    [r.conversation_id, `Marked ${status.name} — its label on the WhatsApp Business app`]);
            }
            done++;
            console.log(`${done}/${picked.length} ${c.phone} ${c.name || ''}: ${r.imported} new, ${r.media} files${status ? `, ${status.name}` : ''}`);
        } catch (err) {
            failed++;
            console.error(`FAILED ${c.phone} ${c.name || ''}: ${err.message}`);
        }
    }
    console.log(`Imported ${done} chats${failed ? `, ${failed} failed` : ''}.`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
