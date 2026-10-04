/**
 * What a transaction actually was.
 *
 * A bank narration is written for the bank: "UPI-SWIGGY LIMITED-SWIGGY@YBL-YESB0000001-4287..."
 * is one payment to one supplier, and nobody reading a hundred of those can tell at a glance where
 * the month went. So each line gets two things — a category, which is what the money was for, and
 * a counterparty, which is who it went to or came from.
 *
 * The rules below are the starting point. Every correction made on the page becomes a rule of its
 * own in `bank_rules`, matched before these, so the same narration is never re-categorised by hand
 * twice. Nothing is ever guessed into a category it does not clearly match: unmatched lines stay
 * Uncategorised, where they can be seen and dealt with, rather than being quietly averaged into
 * something that looks tidy.
 */

// The vocabulary the page groups by. Ordered the way a P&L reads, income first.
const CATEGORIES = [
    'Sales settlements', 'Other income', 'Refunds to customers',
    // Making the product, in the order it is made: cloth, cutting and stitching, the finished
    // garment, then what goes on it and around it. Split this way because they are different
    // suppliers and different questions — "what did fabric cost this month" is not "what did
    // stitching cost".
    'Fabric', 'Stitching', 'Garments & blanks', 'Printing & embroidery', 'Packaging',
    'Advertising', 'Shipping & logistics',
    'Salaries & contractors', 'Rent & utilities', 'Software & subscriptions',
    'Taxes & statutory', 'Bank charges', 'Interest', 'Loan & EMI',
    'Owner drawings', 'Transfer between own accounts', 'Cash withdrawal',
    'Uncategorised',
];

// Matched against the whole narration, in order — the first hit wins, so the specific ones come
// before the broad ones.
const SEED_RULES = [
    // Money coming in
    [/razorpay|rzpy|rzp\b/i, 'Sales settlements', 'Razorpay'],
    [/shopify payments|shopify.*payout/i, 'Sales settlements', 'Shopify Payments'],
    [/payu|cashfree|phonepe\s*merchant|paytm\s*merchant|ccavenue/i, 'Sales settlements', null],
    [/\bint\.?\s*pd\b|interest paid|int credit/i, 'Interest', 'Bank interest'],

    // The trade. Printing before anything with "wear" in it, or "Printwear" becomes a garment
    // supplier; packaging before fabric, or a packing supplier with "poly" in its name becomes
    // one. Only words that can only mean one thing — a guess here quietly collects a column of
    // unrelated payments under the wrong heading.
    [/\b(print(ers?|ing|wear)?|dtf|embroid\w*|screen ?print|sublimation)\b/i, 'Printing & embroidery', null],
    [/\b(packag\w*|packing|carton|corrugat\w*|poly ?(bag|cover)|labels?)\b/i, 'Packaging', null],
    [/\b(fabric|fabrics|textile|textiles|mills?|yarn|cotton|dyeing|dyers?|processors?|handloom|suiting)\b/i, 'Fabric', null],
    [/\b(stitch\w*|tailor\w*|sewing|job ?work)\b/i, 'Stitching', null],
    [/\b(garments?|clothing|apparels?|hosiery|knitwears?|knits?)\b/i, 'Garments & blanks', null],

    // What the money goes on
    [/facebk|facebook|meta platforms|meta ads/i, 'Advertising', 'Meta'],
    [/google\s*(ads|ireland|asia)|adwords/i, 'Advertising', 'Google Ads'],
    // A courier paying us is not a shipping cost: it is the cash it collected on delivery.
    [/delhivery|shiprocket|bluedart|blue dart|dtdc|ekart|xpressbees|india post|shadowfax/i, 'Shipping & logistics', null, 'cod'],
    [/shopify(?!.*payout)/i, 'Software & subscriptions', 'Shopify'],
    [/aws|amazon web|atlassian|adobe|canva|figma|zoho|slack|notion|openai|anthropic|claude/i, 'Software & subscriptions', null],
    [/salary|sal\b.*credit|payroll/i, 'Salaries & contractors', null],
    [/\brent\b/i, 'Rent & utilities', null],
    [/electricity|tneb|bescom|water board|gas bill|broadband|airtel|jio|vodafone|bsnl/i, 'Rent & utilities', null],
    [/\bemi\b|loan repay|loan a\/c/i, 'Loan & EMI', null],
    [/atm.*wdl|cash wdl|nwd-|atw-|cash withdrawal/i, 'Cash withdrawal', null],
    // Bank's own charges, which hide in dozens of spellings
    [/\b(chrg|chgs?|charges?|comm|fee)\b|amb chrg|sms chrg|imps.*chg|neft chg|annual fee|processing fee/i, 'Bank charges', 'Bank'],
    // A tax payment, as opposed to the GST charged on a bank fee, which is matched above.
    [/gst|cbdt|income tax|tds|advance tax|itns|challan/i, 'Taxes & statutory', null],
    [/reversal|refund|rtn|returned/i, 'Refunds to customers', null],
    [/self|own a\/c|trf to own/i, 'Transfer between own accounts', null],
];

/** UPI-<name>-<vpa>-<bank>-<ref>-<remark>, NEFT CR-<ifsc>-<name>-..., IMPS-<ref>-<name>-... */
function counterpartyFrom(narration) {
    const n = String(narration || '').trim();
    const parts = n.split(/[-/]/).map(p => p.trim()).filter(Boolean);

    if (/^upi/i.test(n) && parts[1]) return titled(parts[1]);
    if (/^(neft|rtgs)/i.test(n)) {
        // The name is the first segment that is neither an IFSC nor a reference number.
        const hit = parts.slice(1).find(p => /[a-z]{3}/i.test(p) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(p) && !/^\d+$/.test(p));
        return hit ? titled(hit) : null;
    }
    if (/^imps/i.test(n)) {
        const hit = parts.slice(1).find(p => /[a-z]{4}/i.test(p) && !/^\d+$/.test(p));
        return hit ? titled(hit) : null;
    }
    if (/^(ach|nach|ecs)/i.test(n) && parts[1]) return titled(parts[1]);
    // Card and POS lines read "POS 1234XXXX5678 SWIGGY" — the tail is the merchant.
    if (/^(pos|vps|ecom)/i.test(n)) {
        const tail = n.replace(/^(pos|vps|ecom)\s*/i, '').replace(/\b[\dX*]{8,}\b/g, ' ').trim();
        return tail ? titled(tail.split(/\s{2,}/)[0]) : null;
    }
    // Anything else: the longest stretch of words in it, which is almost always the other party's
    // name sitting among reference numbers.
    const words = n.replace(/[^A-Za-z ]+/g, ' ').split(/\s{1,}/)
        .filter(w => w.length > 2 && !/^(upi|neft|rtgs|imps|ach|nach|ecs|dr|cr|ltd|net|bank|txn|ref|inb|tpt|pvt|the|and|for)$/i.test(w));
    if (words.length) {
        // The run of consecutive words, not the single longest: "HEAVEN STRUCTURES PRIVATE" is a
        // name, "HEAVEN" on its own is half of one.
        let best = [], run = [];
        for (const w of n.replace(/[^A-Za-z ]+/g, '|').split('|')) {
            run = w.trim().split(/\s+/).filter(x => x.length > 2);
            if (run.join(' ').length > best.join(' ').length) best = run;
        }
        if (best.join(' ').length >= 5) return titled(best.join(' '));
    }
    return null;
}

/**
 * Is this actually a name?
 *
 * The fallback happily lifts a reference code or the city an ATM stands in. Neither is a payee,
 * and a wrong name is worse than none — it collects a column of unrelated payments under it.
 */
function looksLikeName(candidate, narration) {
    if (!candidate) return false;
    const c = String(candidate).trim();
    if (c.length < 3) return false;
    if (/^[x*]+$/i.test(c.replace(/\s/g, ''))) return false;              // masked card digits
    // A single word with no vowels in it is a reference code. A name of two or more words is a
    // name even when one of them reads like one — "EDTODO TECHNOVATIONSLLP" is a real supplier.
    if (!/\s/.test(c) && /[bcdfghjklmnpqrstvwxyz]{5,}/i.test(c)) return false;
    if (/\b(atm|nwd|atw)\b/i.test(narration) && !/[a-z]{3,}\s[a-z]{3,}/i.test(c)) return false;
    return true;
}

/** SWIGGY LIMITED → Swiggy Limited, but leave short all-caps codes alone. */
const titled = (s) => String(s).replace(/\s+/g, ' ').trim()
    .split(' ')
    .map(w => (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ')
    .slice(0, 60);

/** UPI, NEFT, IMPS… — how the money moved, which is worth filtering on its own. */
function channelFrom(narration) {
    const n = String(narration || '');
    if (/^upi/i.test(n)) return 'UPI';
    if (/^(neft|rtgs)/i.test(n)) return /^rtgs/i.test(n) ? 'RTGS' : 'NEFT';
    if (/^imps/i.test(n)) return 'IMPS';
    if (/^(ach|nach|ecs)/i.test(n)) return 'ACH';
    if (/\b(atm|nwd|atw)\b/i.test(n)) return 'ATM';
    if (/^(pos|vps|ecom)/i.test(n)) return 'Card';
    if (/^(chq|cheque|clg)/i.test(n)) return 'Cheque';
    return null;
}

/**
 * Category and counterparty for one line.
 *
 * `learned` is the rules the team has taught it, which always win: somebody looked at this exact
 * narration and said what it was.
 */
function categorise(narration, { credit = 0 } = {}, learned = []) {
    const n = String(narration || '');
    const named = counterpartyFrom(n);
    const counterparty = looksLikeName(named, n) ? named : null;
    const channel = channelFrom(n);

    for (const rule of learned) {
        if (n.toLowerCase().includes(String(rule.match).toLowerCase())) {
            return { category: rule.category, counterparty: rule.counterparty || counterparty, channel, learned: true };
        }
    }
    for (const [re, category, who, flag] of SEED_RULES) {
        if (re.test(n)) {
            // Money arriving from a courier is COD it collected from our customers.
            if (flag === 'cod' && credit) return { category: 'Sales settlements', counterparty: who || counterparty, channel, cod: true };
            // The same word means different things in each direction: a Razorpay line is a
            // settlement coming in and a fee going out.
            if (category === 'Sales settlements' && !credit) return { category: 'Bank charges', counterparty: who || counterparty, channel };
            if (category === 'Refunds to customers' && credit) return { category: 'Other income', counterparty: who || counterparty, channel };
            return { category, counterparty: who || counterparty, channel };
        }
    }
    return { category: 'Uncategorised', counterparty, channel };
}

module.exports = { categorise, counterpartyFrom, channelFrom, looksLikeName, CATEGORIES, SEED_RULES };
