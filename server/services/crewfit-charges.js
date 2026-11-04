/**
 * Additional charges on a Crewfit order — extra printing, a rush fee, courier, design changes.
 *
 * Each charge is { id, label, amount, collect, after_advance?, added_at?, added_by? }, `amount`
 * before GST. They are part of the same supply as the goods, so they sit inside the taxable value
 * and take the order's GST rate, exactly as the designer charge and shipping do.
 *
 * `collect` says which half pays for it: 'split' (half and half, like the order), 'advance' or
 * 'balance'. A charge added once the advance is in always goes on the balance.
 *
 * Before the advance, the drawer works out the split (recompute() in CrewfitOrderDrawer.jsx):
 * advance = half of everything collected 'split', plus the 'advance' charges with their GST.
 */

const COLLECT = ['split', 'advance', 'balance'];

/**
 * Embroidery costs more a piece than printing: the catalogue price is the printed price, and an
 * embroidered piece is this much more (₹499 printed → ₹649 embroidered). "DTF & Embroidery" goes
 * to the embroiderer too, so it carries it as well. The one-off digitising charge is separate.
 */
const EMBROIDERY_EXTRA = 150;
const isEmbroidered = (printingType) => /embroid/i.test(printingType || '');

function chargesOf(order) {
  const raw = order?.extra_charges;
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  return Array.isArray(list) ? list.filter(c => c && Number(c.amount) > 0) : [];
}

/** Sum of the charges before GST. */
const chargesTaxable = (order) => chargesOf(order).reduce((s, c) => s + Number(c.amount), 0);

/** A charge with its GST on, rounded to the rupee. */
const chargeGross = (amount, gstPct) => Number(amount) + Math.round(Number(amount) * (Number(gstPct) || 0) / 100);

/** The order's GST rate, read back from its stored figures (0, 5, 12 or 18). */
function gstPctOf(order) {
  const taxable = (Number(order.product_total) || 0) + (Number(order.designer_charge) || 0)
    + (Number(order.shipping) || 0) + chargesTaxable(order);
  return taxable > 0 ? Math.round((Number(order.gst_amount) || 0) / taxable * 100) : 0;
}

/** "advance (50%)" while the advance is still half the order, plain "advance" once charges moved it. */
const advanceLabel = (order) => {
  const grand = Number(order.grand_total) || 0;
  const half = order.advance == null || Number(order.advance) === Math.round(grand / 2);
  return half ? 'advance (50%)' : 'advance';
};

/** Clean a client-sent list before storing it. */
function sanitiseCharges(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(c => ({
      ...c,
      id: c.id || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label: String(c.label || '').trim().slice(0, 120),
      amount: Math.round(Number(c.amount) * 100) / 100,
      collect: COLLECT.includes(c.collect) ? c.collect : 'split',
    }))
    .filter(c => c.label && c.amount > 0);
}

module.exports = { EMBROIDERY_EXTRA, isEmbroidered, COLLECT, chargesOf, chargesTaxable, chargeGross, gstPctOf, advanceLabel, sanitiseCharges };
