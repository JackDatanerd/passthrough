import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { installGlobalErrorReporting } from './lib/reportError'
import './index.css'

// Uncaught errors and unhandled rejections (the boundaries below only see render failures) reach the owner too.
installGlobalErrorReporting()

// Outer boundary: catches failures in the providers themselves (the inner,
// route-aware boundary lives in App.jsx).
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
