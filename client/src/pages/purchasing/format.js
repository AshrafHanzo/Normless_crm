/** Shared by the Purchasing pages. */
export const BRAND_LABEL = { both: 'Both brands', normless: 'Normless', crewfit: 'Crewfit' }
export const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
export const day = (v) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
