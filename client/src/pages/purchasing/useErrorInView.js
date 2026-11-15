import { useEffect, useRef } from 'react'

/**
 * A drawer's error sits at the top of a long form while the save button is pinned at the bottom,
 * so bring the message into view when it appears. Put the returned ref on the error element.
 */
export default function useErrorInView(error) {
  const ref = useRef(null)
  useEffect(() => { if (error) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [error])
  return ref
}
