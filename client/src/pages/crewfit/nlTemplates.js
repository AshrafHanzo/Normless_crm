/** Small helpers shared by Normless's template screens. */

export const STATUS_LOOK = { APPROVED: 'success', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'error', PAUSED: 'error', DISABLED: 'error' }

/** The editor's form from a template's Meta parts. */
export function formFrom(t) {
  const c = t?.components || []
  const header = c.find(x => x.type === 'HEADER' && x.format === 'TEXT')
  const body = c.find(x => x.type === 'BODY')
  const footer = c.find(x => x.type === 'FOOTER')
  const buttons = c.find(x => x.type === 'BUTTONS')?.buttons || []
  return {
    name: t?.name || '', category: t?.category || 'UTILITY', language: t?.language || 'en',
    header: header?.text || '', header_example: header?.example?.header_text?.[0] || '',
    body: body?.text || t?.body_text || '', examples: body?.example?.body_text?.[0] || [],
    footer: footer?.text || '',
    buttons: buttons.map(b => ({ type: b.type, text: b.text || '', url: b.url || '', phone_number: b.phone_number || '', example: b.example?.[0] || '' })),
  }
}
