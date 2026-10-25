import { Component } from 'react'
import Alert from './Alert'
import { reportClientError } from '../../lib/reportError'

// A failure inside ONE part of a page (an editor, a panel) should cost that part, not the whole screen: the app-wide boundary
// replaces everything, navigation included. This one keeps the page and says what happened where it happened.
// `resetKey` clears the message when the person moves on (a different scan, a different tab).
export default class SectionBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) {
    console.error('Render error (section):', error, info?.componentStack)
    reportClientError('render', error, { componentStack: info?.componentStack, section: this.props.name || null })
  }
  componentDidUpdate(prev) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <Alert variant="error" data-testid="section-error" className={this.props.className}>
        {this.props.message || 'This part of the page could not load.'} Your resume is safe.{' '}
        <button type="button" onClick={() => window.location.reload()} className="font-medium underline underline-offset-2">Reload the page</button>
      </Alert>
    )
  }
}
