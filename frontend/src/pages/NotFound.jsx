import { Link } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import usePageTitle from '../hooks/usePageTitle'

// Unknown URLs used to be silently redirected to the homepage, which hid broken
// links and told visitors nothing. (A SPA can't send a real 404 status, so this
// is also marked noindex via usePageTitle.)
export default function NotFound() {
  usePageTitle('Page not found')
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="text-center">
          <p className="text-sm font-medium text-blue-700 mb-2">404</p>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Page not found</h1>
          <p className="text-sm text-gray-600 mb-6">That link doesn't lead anywhere. It may have been mistyped or moved.</p>
          <Link to="/" className="inline-block bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium px-5 py-2.5 rounded-md transition-colors">
            Back to home
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  )
}
