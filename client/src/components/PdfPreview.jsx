import { useEffect, useRef, useState } from 'react'

/**
 * PDFs drawn in the page, with pdf.js.
 *
 * Not left to the browser's own viewer: some browsers (and the desktop app's embedded one) have
 * none, and an <iframe> of a PDF there is a grey box. Drawing the pages ourselves shows the same
 * thing everywhere — and lets the chat show a first-page thumbnail the way WhatsApp does.
 *
 * pdf.js is a large library, so it is fetched the first time a PDF is shown, not with the app.
 */

let pdfjs = null
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
      .then(([lib, worker]) => { lib.GlobalWorkerOptions.workerSrc = worker.default; return lib })
  }
  return pdfjs
}

async function renderPage(pdf, number, canvas, width) {
  const page = await pdf.getPage(number)
  const base = page.getViewport({ scale: 1 })
  const ratio = window.devicePixelRatio || 1
  const viewport = page.getViewport({ scale: (width / base.width) * ratio })
  canvas.width = viewport.width
  canvas.height = viewport.height
  canvas.style.width = `${width}px`
  canvas.style.height = `${viewport.height / ratio}px`
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
}

/** The first page, small. Calls onPages with the page count once it is known. */
export function PdfThumb({ url, width = 240, onPages, onClick }) {
  const canvasRef = useRef(null)
  const [state, setState] = useState('loading')

  useEffect(() => {
    let cancelled = false
    let doc = null
    loadPdfjs()
      .then(lib => lib.getDocument({ url }).promise)
      .then(async (pdf) => {
        doc = pdf
        if (cancelled) return
        onPages?.(pdf.numPages)
        await renderPage(pdf, 1, canvasRef.current, width)
        if (!cancelled) setState('ready')
      })
      .catch(() => { if (!cancelled) setState('failed') })
    return () => { cancelled = true; doc?.destroy() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, width])

  if (state === 'failed') return null
  return (
    <button type="button" className={`pdf-thumb pdf-thumb-${state}`} onClick={onClick} aria-label="Preview the PDF" style={{ width }}>
      <canvas ref={canvasRef} aria-hidden="true" />
      {state === 'loading' && <span className="pdf-thumb-wait">Loading preview…</span>}
    </button>
  )
}

/** Every page, one under another, as wide as the box it sits in. */
export function PdfViewer({ url, maxPages = 40 }) {
  const boxRef = useRef(null)
  const [pages, setPages] = useState(0)
  const [state, setState] = useState('loading')
  const canvases = useRef([])

  useEffect(() => {
    let cancelled = false
    let doc = null
    loadPdfjs()
      .then(lib => lib.getDocument({ url }).promise)
      .then((pdf) => {
        doc = pdf
        if (!cancelled) setPages(Math.min(pdf.numPages, maxPages))
        return pdf
      })
      .then(async (pdf) => {
        // Wait for the canvases to exist, then draw them in order so page one appears first.
        await new Promise(r => requestAnimationFrame(r))
        const width = Math.max(320, (boxRef.current?.clientWidth || 800) - 32)
        for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
          if (cancelled) return
          const c = canvases.current[i - 1]
          if (c) await renderPage(pdf, i, c, width)
        }
        if (!cancelled) setState('ready')
      })
      .catch(() => { if (!cancelled) setState('failed') })
    return () => { cancelled = true; doc?.destroy() }
  }, [url, maxPages])

  return (
    <div className="pdf-viewer" ref={boxRef}>
      {state === 'failed' && <p className="pdf-viewer-msg">This PDF could not be shown here — use “Open in a new tab”.</p>}
      {state === 'loading' && !pages && <p className="pdf-viewer-msg">Loading…</p>}
      {Array.from({ length: pages }).map((_, i) => (
        <canvas key={i} ref={el => { canvases.current[i] = el }} className="pdf-viewer-page" aria-label={`Page ${i + 1}`} />
      ))}
    </div>
  )
}
