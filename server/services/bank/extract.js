/**
 * Getting readable lines out of a bank's PDF.
 *
 * Statements arrive password-protected and are laid out as a table, which a PDF has no concept of:
 * it holds a scatter of text fragments with coordinates, and the table is something the reader's
 * eye does. So this rebuilds it — fragments are grouped into rows by their y position and ordered
 * by x, which gives back the line as it was printed, with the gaps that separated its columns.
 *
 * The password is used here and nowhere else. It is never written to disk, never logged, and never
 * stored on the statement row: the uploaded file stays exactly as the bank encrypted it.
 *
 * pdfjs is pinned to 4.x on purpose — 5 and 6 need Node 22, and production runs 20.
 */

const fs = require('fs');

// pdfjs ships as ESM; one dynamic import, reused by every later call.
let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

class StatementError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

/** Two fragments belong to the same printed line if their baselines are within this many points. */
const ROW_TOLERANCE = 2.2;
/** A gap this wide reads as a column break rather than a space between words. */
const COLUMN_GAP = 3.2;

/**
 * The document, opened.
 *
 * A wrong password is the single most likely thing to go wrong here, and the one the person
 * uploading can actually fix — so it comes back as its own code rather than a stack trace.
 */
async function open(data, password) {
    const lib = await pdfjs();
    try {
        return await lib.getDocument({
            data: new Uint8Array(data),
            password: password || '',
            // Nothing is rendered, so none of the drawing machinery is needed; without this pdfjs
            // complains about fonts it will never draw.
            useSystemFonts: false,
            isEvalSupported: false,
            disableFontFace: true,
        }).promise;
    } catch (err) {
        const name = err?.name || '';
        if (name === 'PasswordException') {
            throw new StatementError(
                password ? 'That password did not open the statement — check it and try again'
                    : 'This statement is password-protected — enter the password the bank sends with it',
                'PASSWORD');
        }
        if (name === 'InvalidPDFException') throw new StatementError('That file is not a readable PDF', 'NOT_PDF');
        throw err;
    }
}

/**
 * Every page as an array of printed lines.
 *
 * Each line carries its text and the pieces it was made of, with their x positions, because some
 * statements can only be read by column position — a blank cell is a gap, not a word, and which
 * column an amount sits in is what says whether money came in or went out.
 */
async function readLines(fileOrBuffer, password) {
    const data = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
    const doc = await open(data, password);
    const pages = [];

    for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const width = page.view[2] - page.view[0];

        // Fragments, with the baseline and left edge pdfjs reports in the transform matrix.
        const frags = content.items
            .filter(i => typeof i.str === 'string' && i.str.trim() !== '')
            .map(i => ({ text: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 }))
            .sort((a, b) => b.y - a.y || a.x - b.x);

        const rows = [];
        for (const f of frags) {
            const row = rows.find(r => Math.abs(r.y - f.y) <= ROW_TOLERANCE);
            if (row) { row.parts.push(f); row.y = (row.y + f.y) / 2; }
            else rows.push({ y: f.y, parts: [f] });
        }

        pages.push({
            page: n,
            width,
            lines: rows.map(r => {
                const parts = r.parts.sort((a, b) => a.x - b.x);
                // Rebuilt with a single space between words and the original gaps left visible as
                // wider runs, so a column boundary survives into the text form.
                let text = '';
                let cursor = null;
                for (const p of parts) {
                    if (cursor !== null) text += (p.x - cursor > COLUMN_GAP ? '  ' : ' ');
                    text += p.text.trim();
                    cursor = p.x + p.w;
                }
                return { y: r.y, text: text.replace(/\s+$/, ''), parts: parts.map(p => ({ text: p.text.trim(), x: p.x, w: p.w })) };
            }),
        });
    }

    const info = await doc.getMetadata().catch(() => null);
    await doc.destroy();
    return { pages, pageCount: doc.numPages, producer: info?.info?.Producer || null };
}

/** The whole document as plain text, in reading order — handy for sniffing which bank it is. */
const flatten = ({ pages }) => pages.flatMap(p => p.lines.map(l => l.text)).join('\n');

module.exports = { readLines, flatten, StatementError, ROW_TOLERANCE, COLUMN_GAP };
