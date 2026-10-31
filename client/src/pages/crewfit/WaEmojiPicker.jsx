import { useEffect, useRef, useState } from 'react'

/**
 * Emoji for the reply box: the ones a sales chat actually uses, in a few groups, inserted where the
 * cursor is. The phone's own emoji keyboard still works too; this is for a desktop keyboard.
 */
const GROUPS = [
  ['Smileys', '😊 😀 😃 😄 😁 😅 😂 🤣 🙂 😉 😍 🥰 😘 😎 🤩 🥳 🤗 🤔 😇 🙃 😌 😋 😜 🤝 😢 😭 😮 😱 😴 🤐 😬 🙄'],
  ['Hands', '👍 👎 👌 ✌️ 🤞 👏 🙌 🙏 💪 👋 🤙 👉 👈 👆 👇 ✋ 🤚 🫡 🤲 ✍️'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💯 ✨ ⭐ 🌟 🔥 🎉 🎊 🎁 🏆 🥇'],
  ['Work', '✅ ☑️ ❌ ⚠️ ❗ ❓ 📌 📍 📞 📱 💬 📧 📄 📎 🧾 💳 💰 💸 🚚 📦 ⏰ ⏳ 📅 🗓️'],
  ['Crewfit', '👕 👚 🧢 🧥 👔 🎽 🧵 🪡 🎨 🖨️ 📏 🏢 🏫 🏏 ⚽ 🏃 🎓 🍽️'],
]

export default function WaEmojiPicker({ onPick }) {
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="wep" ref={box}>
      <button type="button" className="btn-icon" aria-label="Insert an emoji" title="Emoji" aria-expanded={open}
        onClick={() => setOpen(o => !o)}><span aria-hidden="true" style={{ fontSize: 17, lineHeight: 1 }}>😊</span></button>
      {open && (
        <div className="wep-panel" role="dialog" aria-label="Emoji">
          {GROUPS.map(([name, list]) => (
            <section key={name}>
              <h4>{name}</h4>
              <div className="wep-grid">
                {list.split(' ').map(e => (
                  <button key={e} type="button" aria-label={e} onMouseDown={ev => ev.preventDefault()} onClick={() => onPick(e)}>{e}</button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
