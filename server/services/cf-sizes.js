/**
 * A size split as customers type it — "L-2, XL-3", "M:10 L:20", "2 L, 3 XL", "xl 5 xxl 2" — read
 * into one tidy line the lead and the order can carry: "L-2, XL-3".
 *
 * Only letter sizes are read (XS to 6XL). A number on its own is a quantity far more often than a
 * size, so "36-5" is left for a person rather than guessed at.
 */

const ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
// Sizes and numbers, in the order they are written; other words ("pcs", "nos", "size") are skipped.
const TOKEN = /(?<![A-Za-z'’])([2-6]XL|X{2,5}L|XL|XS|S|M|L)(?![A-Za-z])|(?<![0-9A-Za-z])(\d{1,4})(?![0-9])/gi;

/** "XXL" and "2XL" are the same size; a name the order can sort by. */
function canon(size) {
    const s = String(size).toUpperCase();
    const xs = s.match(/^(X{2,5})L$/);
    return xs ? `${xs[1].length}XL` : s;
}

/**
 * The sizes in some words, as [{ size, count }] in size order, or [] when there are none. Pairs are
 * read size-then-count ("L-2") or count-then-size ("2 L"), whichever way the message starts.
 * Counts for a size said twice are added up.
 */
function parse(text) {
    const tokens = [...String(text || '').matchAll(TOKEN)].map(m => (m[1] ? { size: canon(m[1]) } : { n: Number(m[2]) }));
    const first = tokens.findIndex(t => t.size);
    if (first < 0) return [];
    // A number just before the first size means counts come first ("2 L, 3 XL").
    const countFirst = first > 0 && tokens[first - 1].n != null;
    const sum = new Map();
    for (let i = countFirst ? first - 1 : first; i < tokens.length - 1; i++) {
        const [a, b] = [tokens[i], tokens[i + 1]];
        const size = countFirst ? b.size : a.size;
        const n = countFirst ? a.n : b.n;
        if (!size || !(n > 0)) continue;
        sum.set(size, (sum.get(size) || 0) + n);
        i++;
    }
    return [...sum.entries()].map(([size, count]) => ({ size, count }))
        .sort((x, y) => ORDER.indexOf(x.size) - ORDER.indexOf(y.size));
}

const format = (list) => list.map(p => `${p.size}-${p.count}`).join(', ');
const total = (list) => list.reduce((n, p) => n + p.count, 0);

module.exports = { parse, format, total };
