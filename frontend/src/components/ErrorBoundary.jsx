import { Component } from 'react'

// The app had no error boundary: any exception thrown while rendering (an
// unexpected API shape, a bad regex on user text, a missing field) unmounted the
// ENTIRE React tree and left a blank white page with no way back. This catches
// it, shows a recovery screen, and resets automatically when the route changes.
//
// Pass `resetKey` (e.g. the current pathname) to clear the error on navigation.
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Render error:', error, info?.componentStack)
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div role="alert" className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
          <p className="text-sm text-gray-600 mb-6">
            This page hit an unexpected error. Your data is safe — try again, or head back to the homepage.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium px-4 py-2 rounded-md transition-colors"
            >
              Reload page
            </button>
            <a href="/" className="text-sm text-blue-600 hover:underline">Go home</a>
          </div>
        </div>
      </div>
    )
  }
}
