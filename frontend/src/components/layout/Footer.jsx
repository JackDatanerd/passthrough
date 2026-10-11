import { Link } from 'react-router-dom'

export default function Footer() {
  return (
    <footer className="bg-gray-50 border-t border-gray-200 mt-auto">
      <div className="max-w-5xl mx-auto px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500">
        <p>© {new Date().getFullYear()} Passthrough. ATS Resume Scanner.</p>
        <div className="flex flex-wrap items-center justify-center sm:justify-end gap-x-4 gap-y-2">
          <Link to="/pricing" className="inline-block py-1.5 hover:text-gray-700 transition-colors">Pricing</Link>
          <Link to="/#employers" className="inline-block py-1.5 hover:text-gray-700 transition-colors">For employers</Link>
          <Link to="/check" className="inline-block py-1.5 hover:text-gray-700 transition-colors">Check a resume</Link>
          <Link to="/partner/apply" className="inline-block py-1.5 hover:text-gray-700 transition-colors">Partner program</Link>
          <Link to="/terms" className="inline-block py-1.5 hover:text-gray-700 transition-colors">Terms</Link>
          <Link to="/privacy" className="inline-block py-1.5 hover:text-gray-700 transition-colors">Privacy</Link>
          <a href="mailto:support@passthrough.dev" className="inline-block py-1.5 hover:text-gray-700 transition-colors">
            Support
          </a>
        </div>
      </div>
    </footer>
  )
}
