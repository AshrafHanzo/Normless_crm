// Builds server/guides/shipping-manual.html from the manual's Markdown (the same text as the
// Claude Docs user manual). Usage: node build-manual.js <manual.md> <out.html>
const fs = require('fs');
const [src, out] = process.argv.slice(2);
const md = fs.readFileSync(src, 'utf8');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── the flow diagram, the same drawing as in the doc ──
function diagram() {
    const W = 148, H = 52, c1 = 98, c2 = 283, c3 = 467, c4 = 652, rA = 104, rB = 214, rC = 324, rD = 434;
    const box = (cx, cy, name, sub, kind = '') => `<g><rect x="${cx - W / 2}" y="${cy - H / 2}" width="${W}" height="${H}" rx="8" class="b ${kind}"/>`
        + `<text x="${cx}" y="${cy - 3}" text-anchor="middle" class="n">${name}</text><text x="${cx}" y="${cy + 15}" text-anchor="middle" class="s">${sub}</text></g>`;
    const line = (d) => `<path d="${d}" class="l" marker-end="url(#a)"/>`;
    const lbl = (x, y, t, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="s">${t}</text>`;
    return `<svg class="flow" viewBox="0 48 760 420" role="img" aria-label="How a parcel moves, from order to delivery">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ah"/></marker></defs>
${line(`M${c1 + W / 2} ${rA}H${c2 - W / 2}`)}${line(`M${c2 + W / 2} ${rA}H${c3 - W / 2}`)}${line(`M${c3 + W / 2} ${rA}H${c4 - W / 2}`)}
${line(`M${c4} ${rA + H / 2}V${rC - H / 2}`)}${line(`M${c4 - 44} ${rA + H / 2}V${rB}H${c3 + W / 2}`)}${line(`M${c3} ${rB - H / 2}V${rA + H / 2}`)}
${line(`M${c2 - 30} ${rA + H / 2}V${rB - H / 2}`)}${line(`M${c2 + 30} ${rB - H / 2}V${rA + H / 2}`)}
${line(`M${c4 - W / 2} ${rC}H${c3 + W / 2}`)}${line(`M${c3 - W / 2} ${rC}H${c2 + W / 2}`)}
${line(`M${c3 + 30} ${rC + H / 2}V${rD - H / 2}`)}${line(`M${c3 - 30} ${rD - H / 2}V${rC + H / 2}`)}${line(`M${c3 - W / 2} ${rD}H${c2 + W / 2}`)}
${box(c1, rA, 'Order placed', 'in Shopify')}${box(c2, rA, 'Pending AWB', 'pack it first')}${box(c3, rA, 'Get AWB + label', 'Ready to ship')}${box(c4, rA, 'Ready for pickup', 'on the shelf')}
${box(c2, rB, 'On hold', 'can’t ship yet')}${box(c3, rB, 'Cancelled', 'needs a new AWB', 'warn')}
${box(c4, rC, 'In transit', 'with Delhivery')}${box(c3, rC, 'Out for delivery', 'today')}${box(c2, rC, 'Delivered', 'done', 'main')}
${box(c3, rD, 'Delivery failed', 'call the customer', 'warn')}${box(c2, rD, 'Returned (RTO)', 'back with us')}
${lbl((c2 + c3) / 2, rA - 36, 'after packing')}${lbl((c3 + c4) / 2, rA - 36, 'pickup booked')}${lbl(c4 + 8, rB + 40, 'picked up', 'start')}
${lbl((c3 + W / 2 + c4 - 44) / 2, rB + 18, 'not picked')}${lbl(c3 + 8, (rA + rB) / 2 + 4, 're-create', 'start')}
${lbl(c2 - 38, (rA + rB) / 2 + 4, 'held', 'end')}${lbl(c2 + 38, (rA + rB) / 2 + 4, 'released', 'start')}
${lbl(c3 + 38, (rC + rD) / 2 + 4, 'attempt fails', 'start')}${lbl(c3 - 38, (rC + rD) / 2 + 4, 're-attempt', 'end')}${lbl((c2 + c3) / 2, rD - 8, 'RTO')}
</svg>`;
}

// ── markdown subset → html ──
const lines = md.split('\n');
let html = '', title = '', lead = '';
const toc = [];
let i = 0, inSection = false;
const para = [];
const flush = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>\n`; para.length = 0; } };
while (i < lines.length) {
    const ln = lines[i];
    if (/^# /.test(ln)) { title = ln.slice(2).trim(); i++; continue; }
    if (/^## /.test(ln)) {
        flush();
        const h = ln.slice(3).trim(), id = slug(h);
        toc.push({ h, id });
        if (inSection) html += '</section>\n';
        html += `<section id="${id}"><h2>${inline(h)}</h2>\n`; inSection = true; i++; continue;
    }
    if (ln.trim() === '[[DIAGRAM]]') { flush(); html += `<figure>${diagram()}</figure>\n`; i++; continue; }
    if (/^\|/.test(ln)) {
        flush();
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.replace(/^\||\|$/g, '').split(' | ').map(c => c.trim());
        const head = cells(rows[0]);
        html += `<div class="tbl"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`
            + rows.slice(2).map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>\n';
        continue;
    }
    if (/^(\d+\.|-) /.test(ln)) {
        flush();
        const ordered = /^\d+\./.test(ln);
        html += ordered ? '<ol>' : '<ul>';
        while (i < lines.length && /^(\d+\.|-) /.test(lines[i])) {
            let item = lines[i].replace(/^(\d+\.|-) /, ''); i++;
            let sub = '';
            while (i < lines.length && /^ {2,}- /.test(lines[i])) { sub += `<li>${inline(lines[i].replace(/^ +- /, ''))}</li>`; i++; }
            html += `<li>${inline(item)}${sub ? `<ul>${sub}</ul>` : ''}</li>`;
        }
        html += ordered ? '</ol>\n' : '</ul>\n';
        continue;
    }
    if (!ln.trim()) { flush(); i++; continue; }
    if (!inSection && !lead) { lead = ln.trim(); i++; continue; }
    para.push(ln.trim()); i++;
}
flush();
if (inSection) html += '</section>\n';

const page = `<title>${esc(title)}</title>
<style>
/* The Shipping user manual: the same text as the Claude Docs manual, laid out for the CRM's guide
   panel. No scripts: the CRM shows guides in a sandboxed frame. Rebuilt from the Markdown with
   build-manual.js; edit the doc, export it, rebuild. */
:root {
  --paper: #f6f5f2; --sheet: #ffffff; --ink: #1b1a17; --muted: #625d55; --line: #e3ded4; --line-strong: #b9b2a5;
  --accent: #4f46e5; --accent-soft: #eceafd; --warn: #b45309; --warn-soft: #fdf1dd; --good: #157f3b;
  --body: "Inter", "Segoe UI", Roboto, system-ui, sans-serif; --radius: 12px;
}
:root[data-theme="dark"] {
  --paper: #0f0f12; --sheet: #17171c; --ink: #ecebf0; --muted: #a3a1ad; --line: #2a2a33; --line-strong: #4a4955;
  --accent: #a5a0ff; --accent-soft: #23214a; --warn: #f2b45c; --warn-soft: #3a2a13; --good: #62cf8b; color-scheme: dark;
}
* { box-sizing: border-box; }
body { background: var(--paper); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.6; margin: 0; }
.wrap { max-width: 900px; margin: 0 auto; padding: 36px 20px 72px; display: flex; flex-direction: column; gap: 40px; }
header { display: flex; flex-direction: column; gap: 12px; }
.eyebrow { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
h1 { font-size: clamp(28px, 5vw, 38px); line-height: 1.15; margin: 0; letter-spacing: -0.01em; }
.lead { font-size: 16.5px; color: var(--muted); margin: 0; max-width: 66ch; }
nav.toc { background: var(--sheet); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
nav.toc b { display: block; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
nav.toc ol { margin: 0; padding-left: 20px; columns: 2 260px; column-gap: 32px; }
nav.toc li { break-inside: avoid; padding: 2px 0; }
nav.toc a { color: var(--ink); text-decoration: none; }
nav.toc a:hover { color: var(--accent); text-decoration: underline; }
section { display: flex; flex-direction: column; gap: 14px; scroll-margin-top: 16px; }
h2 { font-size: 22px; line-height: 1.25; margin: 0; padding-top: 8px; border-top: 1px solid var(--line); padding-top: 24px; }
p { margin: 0; max-width: 72ch; }
p > strong:only-child { display: block; margin-top: 6px; font-size: 15.5px; }
ol, ul { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px; max-width: 76ch; }
li ul { margin-top: 6px; }
strong { font-weight: 600; }
em { font-style: italic; color: var(--muted); }
.tbl { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--sheet); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 12px; letter-spacing: .03em; text-transform: uppercase; color: var(--muted); font-weight: 600; background: color-mix(in srgb, var(--line) 35%, transparent); padding: 10px 14px; border-bottom: 1px solid var(--line); }
td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td:first-child { white-space: nowrap; }
td:first-child:has(strong) { white-space: normal; min-width: 150px; }
figure { margin: 0; background: var(--sheet); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
svg.flow { width: 100%; height: auto; display: block; font-family: var(--body); }
svg.flow .b { fill: none; stroke: var(--line-strong); stroke-width: 1.25; }
svg.flow .b.main { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 2; }
svg.flow .b.warn { fill: var(--warn-soft); stroke: var(--warn); stroke-width: 2; }
svg.flow .n { fill: var(--ink); font-size: 13px; font-weight: 600; }
svg.flow .s { fill: var(--muted); font-size: 11.5px; }
svg.flow .l { fill: none; stroke: var(--line-strong); stroke-width: 1.25; }
svg.flow .ah { fill: var(--line-strong); }
footer { color: var(--muted); font-size: 13px; border-top: 1px solid var(--line); padding-top: 16px; }
@media (max-width: 600px) { td:first-child { white-space: normal; } .wrap { padding-top: 24px; gap: 32px; } }
</style>
<div class="wrap">
<header>
  <span class="eyebrow">Normless CRM · Shipping</span>
  <h1>${inline(title)}</h1>
  <p class="lead">${inline(lead)}</p>
</header>
<nav class="toc" aria-label="Contents"><b>Contents</b><ol>${toc.map(t => `<li><a href="about:srcdoc#${t.id}" target="_self">${inline(t.h)}</a></li>`).join('')}</ol></nav>
${html}
<footer>Questions or something out of date? Tell an owner or admin; they can update this manual.</footer>
</div>
`;
fs.writeFileSync(out, page);
console.log('wrote', out, page.length, 'bytes,', toc.length, 'sections');
