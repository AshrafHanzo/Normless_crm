/**
 * WhatsApp names and profile photos onto the contacts of a line, from the folder
 * scripts/wa-backup/mac-profiles.py writes (profiles.json + photos/).
 *
 * A name only fills a contact that has none: a name from a live message is newer. A photo replaces
 * the one before. Contacts not already on the line are left alone — this adds no chats.
 *
 *   node scripts/import-wa-profiles.js <folder> --brand crewfit [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const folder = args[0];
const brand = flag('--brand') || 'crewfit';
const dryRun = args.includes('--dry-run');
if (!folder || !fs.existsSync(path.join(folder, 'profiles.json'))) {
    console.error('Usage: node scripts/import-wa-profiles.js <folder with profiles.json> --brand crewfit [--dry-run]');
    process.exit(1);
}

const db = require('../db/connection');
const lines = require('../services/wa-line');

async function main() {
    const profiles = JSON.parse(fs.readFileSync(path.join(folder, 'profiles.json'), 'utf8'));
    await lines.ready?.();
    const line = await lines.get(brand);
    if (!line?.id) throw new Error(`No ${brand} line in the CRM`);
    const contacts = new Map((await db.query('SELECT id, phone, profile_name FROM wa_contacts WHERE line_id = $1', [line.id])).rows.map(r => [r.phone, r]));

    const dir = path.join(__dirname, '..', 'uploads', 'whatsapp', 'avatars');
    const totals = { people: Object.keys(profiles).length, on_this_line: 0, names: 0, photos: 0 };
    for (const [phone, p] of Object.entries(profiles)) {
        const k = contacts.get(phone);
        if (!k) continue;
        totals.on_this_line++;
        if (p.name && !k.profile_name) {
            totals.names++;
            if (!dryRun) await db.query('UPDATE wa_contacts SET profile_name = $2 WHERE id = $1 AND profile_name IS NULL', [k.id, p.name]);
        }
        if (p.photo) {
            totals.photos++;
            if (!dryRun) {
                const bytes = fs.readFileSync(path.join(folder, p.photo));
                // Named by its content, so a new photo gets a new address and no browser shows the old one.
                const file = `${k.id}-${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10)}.jpg`;
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, file), bytes);
                await db.query('UPDATE wa_contacts SET avatar_url = $2 WHERE id = $1', [k.id, `/uploads/whatsapp/avatars/${file}`]);
            }
        }
    }
    console.log(JSON.stringify({ brand, dry_run: dryRun, ...totals }, null, 1));
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
