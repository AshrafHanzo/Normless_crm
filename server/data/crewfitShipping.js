// Same rate table used for real orders (client/src/pages/crewfit/CrewfitOrderDrawer.jsx SHIP_ZONES) —
// mirrored here so the Quick Calc quote endpoint can compute an authoritative shipping charge
// server-side (never trust a client-submitted total for something that becomes a real payment link).
const SHIP_ZONES = {
  'Chennai': { flat: [[0.25, 40], [0.5, 60], [1, 80], [2, 150], [3, 180]], perKg: [[10, 45], [24, 35], [Infinity, 30]] },
  'Tamil Nadu': { flat: [[0.25, 60], [0.5, 80], [1, 110], [2, 180], [3, 250]], perKg: [[10, 55], [24, 45], [Infinity, 40]] },
  'South (KA/AP/KL/TLN)': { flat: [[0.25, 100], [0.5, 120], [1, 170], [2, 300], [3, 450]], perKg: [[10, 100], [24, 75], [Infinity, 70]] },
  'Metro (MUM/DEL/KOL/AMD)': { flat: [[0.25, 150], [0.5, 250], [1, 270], [2, 500], [3, 600]], perKg: [[10, 200], [24, 200], [Infinity, 200]] },
  'ROI (North/East/West)': { flat: [[0.25, 200], [0.5, 250], [1, 300], [2, 550], [3, 675]], perKg: [[10, 250], [24, 250], [Infinity, 250]] },
  'Jammu & Andaman': { flat: [[0.25, 200], [0.5, 250], [1, 300], [2, 550], [3, 700]], perKg: [[10, 280], [24, 210], [Infinity, 200]] },
};
const PIECE_WEIGHT_KG = 0.5; // assume 500g per t-shirt, same assumption used for real orders

function shippingFor(region, qty) {
  const zone = SHIP_ZONES[region];
  const n = Number(qty) || 0;
  if (!zone || !n) return null;
  const weightKg = n * PIECE_WEIGHT_KG;
  for (const [maxKg, price] of zone.flat) if (weightKg <= maxKg) return price;
  for (const [maxKg, rate] of zone.perKg) if (weightKg <= maxKg) return Math.ceil(weightKg) * rate;
  return null;
}

module.exports = { SHIP_ZONES, SHIP_REGIONS: Object.keys(SHIP_ZONES), PIECE_WEIGHT_KG, shippingFor };
