import { Link } from 'react-router-dom'

export default function Footer() {
  return (
    <footer className="bg-gray-50 border-t border-gray-200 mt-auto">
      <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500">
        <p>© {new Date().getFullYear()} Passthrough. ATS Resume Scanner.</p>
        <div className="flex items-center gap-4">
          <Link to="/pricing" className="hover:text-gray-700 transition-colors">Pricing</Link>
          <Link to="/terms" className="hover:text-gray-700 transition-colors">Terms</Link>
          <Link to="/privacy" className="hover:text-gray-700 transition-colors">Privacy</Link>
          <a href="mailto:support@passthrough.dev" className="hover:text-gray-700 transition-colors">
            Support
          </a>
        </div>
      </div>
    </footer>
  )
}
