/** What a chat file is, for showing it: image, pdf, video, audio, or just a file. */
export const mediaKind = (item) => {
  const mime = String(item?.mime || '')
  const ext = String(item?.name || item?.url || '').split('?')[0].split('.').pop().toLowerCase()
  if (/^image\//.test(mime) && !/photoshop|svg/.test(mime)) return 'image'
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext)) return 'image'
  if (/pdf/.test(mime) || ext === 'pdf') return 'pdf'
  if (/^video\//.test(mime) || ['mp4', 'mov', '3gp', 'webm'].includes(ext)) return 'video'
  if (/^audio\//.test(mime) || ['ogg', 'opus', 'mp3', 'm4a', 'aac'].includes(ext)) return 'audio'
  return 'file'
}
