/**
 * Shoot samples — garments the marketing team borrows to photograph.
 *
 * The life of one: marketing asks for it with a purpose, an admin signs it off, production prints
 * it, marketing shoots with it, and it comes back. What makes it worth modelling separately from a
 * seeding order is that last step — the garment returns, so it is a loan, not a giveaway, and at
 * the end of it there is a finished piece on the shelf that a customer can still buy.
 *
 * Stock follows the same rule as everywhere else: a blank leaves when the garment is printed, and
 * it is not credited when the sample comes back, because the garment still exists — it is on the
 * RTO shelf. A request filled from that shelf never deducts a blank at all, since nothing is made.
 */

const express = require('express');
const db = require('../db/connection');
const inv = require('../services/inventory');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();

// Marketing raises these, so the marketing permission is what opens the tab.
router.use(async (req, res, next) => {
  try {
    if (!await hasPermission(req, 'can_view_marketing')) return res.status(403).json({ error: 'Access denied' });
    next();
  } catch (err) { next(err); }
});

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canApprove = (req) => hasPermission(req, 'can_approve_marketing');

// The pipeline, in order. A blank is held from the point the garment is actually printed.
// Two ways a request ends: the garment comes back and goes on the shelf, or the model keeps it as
// the barter for the shoot. Both spend the blank; only one leaves anything behind.
const STATUSES = ['Pending Approval', 'Approved', 'In Production', 'With Marketing', 'Returned', 'Given as barter', 'Cancelled'];
const BARTER = 'Given as barter';
const AWAITING = 'Pending Approval';

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v || 'null') ?? fallback : (v || fallback); } catch { return fallback; } };
const refLabel = (row) => (row?.ref_no ? `SH${String(row.ref_no).padStart(3, '0')}` : '—');
const hydrate = (row) => ({ ...row, items: safeJson(row.items, []), ref: refLabel(row) });

/** Drop rows production could not act on, and normalise quantities coming from text inputs. */
function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(it => ({
      product: trim(it.product),
      variant: trim(it.variant),
      qty: parseInt(it.qty, 10) || 0,
      shopify_product_id: it.shopify_product_id || null,
      shopify_variant_id: it.shopify_variant_id || null,
      blank_type: trim(it.blank_type),
      color: trim(it.color),
      size: trim(it.size),
    }))
    .filter(it => it.product && it.qty > 0);
}
const totalQty = (items) => items.reduce((n, it) => n + it.qty, 0);

/**
 * Push a request's current state at blank stock.
 *
 * Never allowed to fail the save that triggered it: the request really did change, and refusing it
 * because a stock write went wrong leaves the two further apart, not closer.
 */
async function applyStock(row) {
  try {
    return await inv.applySampleRequest(row);
  } catch (err) {
    console.error('sample inventory apply failed:', err.message);
    return { error: 'Blank stock could not be updated for this request' };
  }
}

// GET /api/marketing/samples
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? 'WHERE status = $1' : '';
    const rows = (await db.query(
      `SELECT * FROM marketing_samples ${where} ORDER BY created_at DESC, id DESC LIMIT 300`,
      status ? [status] : [])).rows.map(hydrate);

    // What the RTO shelf could already supply, so a request is never printed for something that
    // is sitting in the building. Same matching rule the order notices use.
    let onShelf = [];
    try {
      const shelf = await inv.rtoAvailable();
      const index = inv.availabilityIndex(shelf);
      // The shelf row says a piece exists; taking one needs the entry it comes out of, so the two
      // are resolved together rather than leaving the client to guess.
      const entries = (await db.query(
        `SELECT id, variant_id, product_title, variant, (qty - qty_used - qty_written_off) AS available
           FROM inventory_rto WHERE (qty - qty_used - qty_written_off) > 0
          ORDER BY created_at ASC`)).rows;
      const entryFor = (line) => entries.find(e => (line.variant_id && e.variant_id
        ? String(e.variant_id) === String(line.variant_id)
        : e.product_title === line.product_title && e.variant === line.variant));

      onShelf = rows
        .filter(r => ['Pending Approval', 'Approved'].includes(r.status))
        .map(r => ({
          id: r.id,
          lines: inv.matchesForOrder({ line_items_json: JSON.stringify(r.items.map(it => ({
            title: it.product, quantity: it.qty, variant: it.variant,
            shopify_product_id: it.shopify_product_id, shopify_variant_id: it.shopify_variant_id,
          }))) }, index).map(l => ({ ...l, entry_id: entryFor(l)?.id || null })).filter(l => l.entry_id),
        }))
        .filter(x => x.lines.length);
    } catch (err) {
      console.error('sample RTO check failed:', err.message);
    }

    const counts = (await db.query(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_qty),0)::int AS units
         FROM marketing_samples GROUP BY status`)).rows;
    res.json({
      samples: rows,
      onShelf: Object.fromEntries(onShelf.map(x => [x.id, x.lines])),
      statuses: STATUSES,
      canApprove: await canApprove(req),
      summary: {
        awaiting: counts.find(c => c.status === AWAITING)?.n || 0,
        in_production: counts.find(c => c.status === 'In Production')?.n || 0,
        out: counts.find(c => c.status === 'With Marketing')?.n || 0,
        returned: counts.find(c => c.status === 'Returned')?.n || 0,
        bartered: counts.find(c => c.status === BARTER)?.n || 0,
      },
    });
  } catch (err) {
    console.error('samples list error:', err);
    res.status(500).json({ error: 'Failed to load sample requests' });
  }
});

// POST /api/marketing/samples — always raised unapproved; a client cannot skip the sign-off.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!trim(b.purpose)) return res.status(400).json({ error: 'Say what the sample is for' });
    const items = cleanItems(b.items);
    if (!items.length) return res.status(400).json({ error: 'Add at least one product with a quantity' });

    const r = await db.query(
      `INSERT INTO marketing_samples (ref_no, purpose, shoot_date, requested_for, items, total_qty, status, notes, created_by)
       VALUES ((SELECT COALESCE(MAX(ref_no), 0) + 1 FROM marketing_samples), $1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [trim(b.purpose), b.shoot_date || null, trim(b.requested_for), JSON.stringify(items),
        totalQty(items), AWAITING, trim(b.notes), req.user?.username || null]);
    res.status(201).json(hydrate(r.rows[0]));
  } catch (err) {
    console.error('sample create error:', err);
    res.status(500).json({ error: 'Failed to raise the request' });
  }
});

// PUT /api/marketing/samples/:id — edit the request itself, not its stage.
router.put('/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const current = (await db.query('SELECT * FROM marketing_samples WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'Request not found' });
    const items = b.items ? cleanItems(b.items) : safeJson(current.items, []);
    if (!items.length) return res.status(400).json({ error: 'Add at least one product with a quantity' });

    const r = await db.query(
      `UPDATE marketing_samples SET purpose=$1, shoot_date=$2, requested_for=$3, items=$4, total_qty=$5,
              notes=$6, updated_at=CURRENT_TIMESTAMP WHERE id=$7 RETURNING *`,
      [trim(b.purpose) || current.purpose, b.shoot_date || null, trim(b.requested_for),
        JSON.stringify(items), totalQty(items), trim(b.notes), req.params.id]);
    // Editing the items of a request already in production moves stock by the difference.
    const stock = await applyStock(r.rows[0]);
    res.json({ ...hydrate(r.rows[0]), inventory: stock });
  } catch (err) {
    console.error('sample update error:', err);
    res.status(500).json({ error: 'Failed to update the request' });
  }
});

/**
 * POST /api/marketing/samples/:id/status { status }
 *
 * Every stage change goes through here so the stock rule lives in one place: held from the moment
 * the garment is printed, released if the request goes back before that, and turned into a piece
 * on the RTO shelf when it comes home.
 */
router.post('/:id/status', async (req, res) => {
  try {
    const next = String(req.body?.status || '');
    if (!STATUSES.includes(next)) return res.status(400).json({ error: 'Unknown status' });

    const current = (await db.query('SELECT * FROM marketing_samples WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'Request not found' });

    // Approval is the whole point of the stage, so it cannot be skipped by jumping past it.
    if (current.status === AWAITING && next !== 'Cancelled' && !await canApprove(req)) {
      return res.status(403).json({ error: 'Only someone who can approve marketing orders can release this for production' });
    }
    if (current.status === AWAITING && !['Approved', 'Cancelled'].includes(next)) {
      return res.status(409).json({ error: 'This request has not been approved yet — approve it before production can start' });
    }

    const stamps = [];
    const vals = [next];
    if (next === 'Approved' && !current.approved_at) {
      stamps.push(`approved_by = $${vals.length + 1}`); vals.push(req.user?.username || null);
      stamps.push('approved_at = CURRENT_TIMESTAMP');
    }
    if (next === 'In Production' && !current.production_at) stamps.push('production_at = CURRENT_TIMESTAMP');
    if (next === 'With Marketing' && !current.handed_over_at) stamps.push('handed_over_at = CURRENT_TIMESTAMP');
    if (next === 'Returned') {
      stamps.push(`received_by = $${vals.length + 1}`); vals.push(req.user?.username || null);
      stamps.push('returned_at = CURRENT_TIMESTAMP');
    }
    if (next === BARTER) {
      stamps.push(`given_by = $${vals.length + 1}`); vals.push(req.user?.username || null);
      stamps.push('given_at = CURRENT_TIMESTAMP');
    }
    vals.push(req.params.id);

    const r = await db.query(
      `UPDATE marketing_samples SET status = $1${stamps.length ? ', ' + stamps.join(', ') : ''},
              updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length} RETURNING *`, vals);
    const row = r.rows[0];

    const stock = await applyStock(row);

    // Back from the shoot: the garments exist, are printed, and can go to a customer — which is
    // exactly what the RTO shelf is for. A bartered one is deliberately not shelved: it left with
    // the model, and putting it on the shelf would offer a customer a garment nobody has.
    let shelved = null;
    if (next === 'Returned' && current.status !== 'Returned') {
      try {
        shelved = await inv.shelveSampleReturn(row, req.user?.username);
      } catch (err) {
        console.error('sample shelving failed:', err.message);
        shelved = { error: 'The pieces could not be added to the RTO shelf' };
      }
    }
    res.json({ ...hydrate(row), inventory: stock, shelved });
  } catch (err) {
    console.error('sample status error:', err);
    res.status(500).json({ error: 'Failed to move the request' });
  }
});

/**
 * POST /api/marketing/samples/:id/take-from-rto { rto_id, qty }
 *
 * Fill the request from a piece already on the shelf. No blank is deducted, because none is spent
 * — and none is credited either, for the same reason. The garment simply moves from the shelf to
 * the shoot, and comes back to the shelf when the request is returned.
 */
router.post('/:id/take-from-rto', async (req, res) => {
  try {
    const row = (await db.query('SELECT * FROM marketing_samples WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Request not found' });
    if (row.status === AWAITING) return res.status(409).json({ error: 'Approve the request first' });

    const out = await inv.takeRtoForSample(req.body?.rto_id, req.body?.qty || 1, refLabel(row), req.user?.username);
    if (out.error) return res.status(out.status || 400).json({ error: out.error });

    const r = await db.query(
      `UPDATE marketing_samples SET from_rto = true, status = 'With Marketing',
              handed_over_at = COALESCE(handed_over_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`, [req.params.id]);
    // Anything held for it before is released — nothing was printed after all.
    const stock = await applyStock(r.rows[0]);
    res.json({ ...hydrate(r.rows[0]), inventory: stock, took: out });
  } catch (err) {
    console.error('sample take-from-rto error:', err);
    res.status(500).json({ error: 'Failed to take that piece from the shelf' });
  }
});

// DELETE /api/marketing/samples/:id — owner/admin only, and it gives back anything still held.
router.delete('/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only the account owner can do this' });
  try {
    await inv.releaseSampleRequest(req.params.id);
    const r = await db.query('DELETE FROM marketing_samples WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('sample delete error:', err);
    res.status(500).json({ error: 'Failed to delete the request' });
  }
});

module.exports = router;
