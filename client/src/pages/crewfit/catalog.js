// Crewfit product catalog — extracted from "Crew Fit Product Catalog V3.0".
// Prices include printing charges. Tiers are MOQ-based (qty → price/piece).

export const COLOR_HEX = {
  White: '#f3f4f6', Black: '#1b1b1f', Maroon: '#7b1e2b', Navy: '#1f2a44', Green: '#2e6b3e',
  'Royal Blue': '#1e40af', Red: '#c0262d', 'Grey Melange': '#9ca3af', Yellow: '#f2c40d',
  'Olive Green': '#5a6b2f', 'Coffee Brown': '#5b4033', 'Petrol Blue': '#1b5566', Beige: '#d8c9a8',
  Lavender: '#b9a7d6', 'Soft Pink': '#f3c6d0', 'Sky Blue': '#7ec8e3', Lilac: '#c8a2c8',
  Teal: '#0f9e8e', Mint: '#a8e6cf', 'Ocean Blue': '#1d6fa5',
}

export const ADULT_SIZES = { header: ['', 'S', 'M', 'L', 'XL', '2XL'], rows: [
  ['Chest', 38, 40, 42, 44, 46], ['Length', 26, 27, 28, 29, 30], ['Sleeve', 7.5, 8, 8.5, 9, 9],
] }

export const CATALOG = [
  {
    id: 'poly-cotton-polo', name: 'Poly Cotton Polos', category: 'Polos', fit: 'Unisex', gsm: 240,
    material: '60% Cotton · 40% Polyester', from: 499,
    features: ['Anti-wrinkle', 'Anti-pilling', 'UV-treated'],
    blurb: 'Workwear comfort of cotton with the rich look of polyester.',
    colors: ['White', 'Maroon', 'Navy', 'Green', 'Royal Blue', 'Red', 'Grey Melange', 'Yellow', 'Black'],
    tiers: [['5–10', 499], ['11–20', 475], ['21–50', 450], ['51–100', 425], ['100+', 'On request']],
  },
  {
    id: 'classic-poly-airtex', name: 'Classic Polos Airtex', category: 'Polos', fit: 'Unisex', gsm: 200,
    material: '100% Micro Polyester (Mars)', from: 499,
    features: ['Antimicrobial', 'Superwick', 'UV protection'],
    blurb: 'Premium performance poly polo that stays crisp all day.',
    colors: ['White', 'Maroon', 'Navy', 'Olive Green', 'Royal Blue', 'Coffee Brown', 'Petrol Blue', 'Black'],
    tiers: [['5–10', 499], ['11–20', 475], ['21–50', 450], ['51–100', 425], ['100+', 'On request']],
  },
  {
    id: 'classic-cotton-polo', name: 'Classic Cotton Polos', category: 'Polos', fit: 'Unisex', gsm: 240,
    material: '100% Combed Cotton Airtex (Bio Washed)', from: 599,
    features: ['Bio washed', 'Pre-shrunk', 'Crisp finish'],
    blurb: 'Smooth, breathable cotton airtex with a smart corporate look.',
    colors: ['White', 'Maroon', 'Navy', 'Green', 'Royal Blue', 'Coffee Brown', 'Petrol Blue', 'Black'],
    tiers: [['5–10', 599], ['11–20', 575], ['21–50', 550], ['51–100', 499], ['100+', 'On request']],
  },
  {
    id: 'regular-tee', name: 'Regular Fit T-Shirt', category: 'T-Shirts', fit: "Men's", gsm: '160–180',
    material: '100% Combed Cotton Single Jersey', from: 399,
    features: ['Bio washed', 'Pre-shrunk', 'Round neck'],
    blurb: 'The everyday round-neck tee — soft, durable, print-ready.',
    colors: ['Black', 'White', 'Beige', 'Lavender', 'Red', 'Coffee Brown', 'Navy', 'Maroon', 'Royal Blue', 'Yellow'],
    tiers: [['5–10', 399], ['11–20', 380], ['21–50', 360], ['51–100', 340], ['100+', 'On request']],
  },
  {
    id: 'oversized-french-terry', name: 'Oversized T-Shirts', category: 'T-Shirts', fit: 'Unisex', gsm: 240,
    material: 'Cotton French Terry', from: 499,
    features: ['Heavyweight', 'Streetwear fit', 'Structured drape'],
    blurb: 'Premium 240 GSM French Terry oversized fit for a bold look.',
    colors: ['Black', 'White', 'Beige', 'Lavender', 'Red', 'Coffee Brown', 'Navy', 'Maroon', 'Royal Blue'],
    tiers: [['5–10', 499], ['11–20', 475], ['21–50', 450], ['51–100', 425], ['100+', 'On request']],
  },
  {
    id: 'oversized-single-jersey', name: 'Unisex Oversized Tees', category: 'T-Shirts', fit: 'Unisex', gsm: 180,
    material: '100% Cotton Single Jersey (Bio Washed)', from: 450,
    features: ['Lightweight', 'Relaxed fit', 'Subtle finish'],
    blurb: 'Everyday oversized tee in soft single jersey.',
    colors: ['Black', 'White', 'Beige', 'Lavender', 'Red', 'Coffee Brown', 'Navy', 'Maroon', 'Royal Blue'],
    tiers: [['5–10', 450], ['11–20', 430], ['21–50', 400], ['51–100', 390], ['100+', 'On request']],
  },
  {
    id: 'kids-round-neck', name: 'Toddlers & Kids Round Neck', category: 'Kids', fit: 'Toddlers 1–6y · Kids 7–14y', gsm: 160,
    material: '100% Ring-spun Super Combed Cotton', from: 350,
    features: ['Soft & gentle', 'For active kids'],
    blurb: 'Gentle, breathable cotton crafted for active toddlers and kids.',
    colors: ['Black', 'White', 'Beige', 'Soft Pink', 'Red', 'Sky Blue', 'Lilac', 'Teal', 'Royal Blue', 'Yellow', 'Mint'],
    tiers: [['5–10', 350], ['11–20', 330], ['21–50', 310], ['51–100', 290], ['100+', 'On request']],
  },
  {
    id: 'kids-collar-neck', name: 'Toddlers & Kids Collar Neck', category: 'Kids', fit: 'Toddlers 1–6y · Kids 7–14y', gsm: 160,
    material: '100% Ring-spun Super Combed Cotton', from: 450,
    features: ['Soft & gentle', 'Collared polo style'],
    blurb: 'Polo-style collar neck for a smart look on little ones.',
    colors: ['Black', 'White', 'Ocean Blue', 'Red', 'Yellow'],
    tiers: [['5–10', 450], ['11–20', 430], ['21–50', 400], ['51–100', 390], ['100+', 'On request']],
  },
]

export const CONTACT = {
  phone: '7338723696', email: 'crewfitfashion@gmail.com',
  address: 'Plot no 2, 2nd Floor, Dhanalakshmi Nagar, Moulivakkam, Iyyappanthangal, Chennai, TN 600125',
}
