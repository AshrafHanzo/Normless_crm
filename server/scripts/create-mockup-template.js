/**
 * Once: the template that sends a mockup for approval outside WhatsApp's 24-hour window.
 *
 * crewfit_mockup_confirm (utility): the mockup as its picture, a line asking the customer to check
 * it, and two quick replies — ✅ Confirm mockup / ✏️ Need changes — which services/cf-mockup.js
 * answers. Meta needs a sample picture to review it; any product photo will do.
 *
 *   node scripts/create-mockup-template.js <sample image path>
 */

const fs = require('fs');
const lines = require('../services/wa-line');
const wa = require('../services/whatsapp');
const { TEMPLATE } = require('../services/cf-mockup');

async function main() {
    const sample = process.argv[2];
    if (!sample || !fs.existsSync(sample)) throw new Error('Give a sample image (JPG or PNG) for Meta to review the template with');
    await lines.ready?.();
    await lines.run('crewfit', async () => {
        const existing = (await wa.fetchTemplates()).find(t => t.name === TEMPLATE);
        if (existing) { console.log(`${TEMPLATE} already exists — ${existing.status}`); return; }
        const handle = await wa.uploadSample(fs.readFileSync(sample), /\.png$/i.test(sample) ? 'image/png' : 'image/jpeg');
        const r = await wa.graph(`/${wa.wabaId()}/message_templates`, {
            method: 'POST',
            body: {
                name: TEMPLATE, language: 'en', category: 'UTILITY',
                components: [
                    { type: 'HEADER', format: 'IMAGE', example: { header_handle: [handle] } },
                    {
                        type: 'BODY',
                        text: 'Hi {{1}}, your Crewfit mockup is ready 🎨 Please check the logo, its size and position, and the colour. Tap Confirm to go ahead with the order, or Need changes to tell us what to change.',
                        example: { body_text: [['Rahul']] },
                    },
                    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: '✅ Confirm mockup' }, { type: 'QUICK_REPLY', text: '✏️ Need changes' }] },
                ],
            },
        });
        console.log(`${TEMPLATE} submitted — ${r.status || 'PENDING'}`);
    });
}

setTimeout(() => main().then(() => process.exit(0), (err) => { console.error(err.message || err); process.exit(1); }), 1500);
