import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { console.error('Page error:', err, info) }
  render() {
    if (this.state.err) {
      return (
        <div className="empty-state" style={{ padding: '80px 20px' }}>
          <div className="empty-icon">⚠️</div>
          <h3>Something went wrong on this page</h3>
          <p style={{ color: 'var(--text-muted)', maxWidth: 480 }}>{String(this.state.err?.message || this.state.err)}</p>
          <button className="btn btn-secondary btn-sm" onClick={() => this.setState({ err: null })} style={{ marginTop: 12 }}>Try again</button>
        </div>
      )
    }
    return this.props.children
  }
}
