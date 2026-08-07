import { useId } from 'react'

/**
 * A dropdown whose value can also just be typed.
 *
 * Backed by a native `<datalist>` rather than a custom popup: it gives the picker *and* free text
 * in one control, keeps the browser's own keyboard and mobile behaviour, and can't trap a value
 * the list doesn't happen to contain — which is the whole point here, since vendors and product
 * names change faster than any list we ship.
 */
export default function ComboInput({ value, onChange, options = [], placeholder, ...props }) {
  const listId = useId()
  return (
    <>
      <input
        list={listId}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        {...props}
      />
      <datalist id={listId}>
        {options.filter(Boolean).map(opt => {
          const val = typeof opt === 'string' ? opt : opt.value
          const label = typeof opt === 'string' ? undefined : opt.label
          return <option key={val} value={val}>{label}</option>
        })}
      </datalist>
    </>
  )
}
