/**
 * A line's saved templates, submitted again to the WhatsApp account now connected to it.
 *
 * When a brand's number moves to another WhatsApp Business Account, its approved templates stay
 * behind in the old one. The CRM keeps each template whole (wa_templates.components: header, body,
 * footer, buttons, examples), so the same wording goes to the new account for Meta to approve
 * again. Then the line's template list is synced from the new account, so the inbox only offers
 * what that account has — the copies as pending until Meta approves them.
 *
 *   node scripts/copy-wa-templates.js --brand crewfit [--prefix crewfit_] [--dry-run]
 *
 * Templates with a photo or document header are left out: their sample file has to be uploaded
 * again, which the Templates page does.
 */

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const brand = flag('--brand') || 'crewfit';
const prefix = flag('--prefix') || '';
const dryRun = args.includes('--dry-run');

const db = require('../db/connection');
const lines = require('../services/wa-line');
const wa = require('../services/whatsapp');

async function main() {
    await lines.ready?.();
    const line = await lines.get(brand);
    if (!line?.id) throw new Error(`No ${brand} line in the CRM`);
    const saved = (await db.query(
        `SELECT name, language, category, components FROM wa_templates WHERE line_id = $1 AND name LIKE $2 ORDER BY name`,
        [line.id, `${prefix}%`])).rows;

    await lines.run(brand, async () => {
        const have = new Set((await wa.fetchTemplates()).map(t => `${t.name}|${t.language}`));
        console.log(`${brand}: account ${wa.wabaId()}, ${saved.length} saved template(s) named ${prefix || 'anything'}*, ${have.size} already in the account`);
        let sent = 0;
        for (const t of saved) {
            const components = JSON.parse(t.components || '[]');
            const media = components.find(c => c.type === 'HEADER' && c.format && c.format !== 'TEXT');
            if (have.has(`${t.name}|${t.language}`)) { console.log(`  ${t.name}: already there`); continue; }
            if (media) { console.log(`  ${t.name}: left out — ${media.format.toLowerCase()} header, add it on the Templates page`); continue; }
            if (dryRun) { console.log(`  ${t.name}: would be submitted (${t.category})`); continue; }
            try {
                const r = await wa.graph(`/${wa.wabaId()}/message_templates`, {
                    method: 'POST', body: { name: t.name, language: t.language, category: t.category, components },
                });
                sent++;
                console.log(`  ${t.name}: submitted — ${r.status || 'PENDING'}`);
            } catch (err) {
                console.log(`  ${t.name}: refused — ${err.message}`);
            }
        }
        if (dryRun) return;

        // The line's list, from the account it now uses.
        const templates = await wa.fetchTemplates();
        const startedAt = new Date();
        for (const t of templates) {
            await db.query(
                `INSERT INTO wa_templates (name, language, category, status, body_text, variables, header_kind, synced_at, line_id, meta_id, components, rejected_reason)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8,$9,$10,$11)
                 ON CONFLICT (line_id, name, language) DO UPDATE
                    SET category = EXCLUDED.category, status = EXCLUDED.status, body_text = EXCLUDED.body_text,
                        variables = EXCLUDED.variables, header_kind = EXCLUDED.header_kind, synced_at = CURRENT_TIMESTAMP,
                        meta_id = EXCLUDED.meta_id, components = EXCLUDED.components, rejected_reason = EXCLUDED.rejected_reason`,
                [t.name, t.language, t.category, t.status, t.body_text, t.variables, t.header_kind, line.id,
                    t.meta_id, JSON.stringify(t.components || []), t.rejected_reason]);
        }
        if (templates.length) await db.query('DELETE FROM wa_templates WHERE synced_at < $1 AND line_id = $2', [startedAt, line.id]);
        const byStatus = {};
        for (const t of templates) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
        console.log(`Submitted ${sent}. The account now has ${templates.length}: ${JSON.stringify(byStatus)}`);
    });
}

main().then(() => process.exit(0), (err) => { console.error(err.message || err); process.exit(1); });
