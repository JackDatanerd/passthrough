import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

export default function Navbar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/')
  }

  return (
    <nav aria-label="Main" className="bg-white border-b border-gray-200">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link to="/" className="font-bold text-blue-700 text-lg tracking-tight">
          Passthrough
        </Link>
        <div className="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm">
          {/* Hidden for logged-in users on narrow screens — least essential
              item once someone already has an account (still reachable via
              the footer), and without it this row was right at the edge of
              overflowing a 375px viewport alongside Dashboard/Sign out. */}
          <Link to="/pricing" className={`text-gray-600 hover:text-gray-900 transition-colors ${user ? 'hidden sm:block' : ''}`}>
            Pricing
          </Link>
          {/* Anchor into the employer section on the homepage */}
          <Link to="/#employers" className="text-gray-600 hover:text-gray-900 transition-colors hidden sm:block">
            For employers
          </Link>
          {user ? (
            <>
              <Link to="/dashboard" className="text-gray-600 hover:text-gray-900 transition-colors">
                Dashboard
              </Link>
              {/* The admin page had no link anywhere — admins had to type the URL. */}
              {user.role === 'ADMIN' && (
                <Link to="/admin" className="text-gray-600 hover:text-gray-900 transition-colors">
                  Admin
                </Link>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="text-gray-600 hover:text-gray-900 transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-gray-600 hover:text-gray-900 transition-colors">
                Sign in
              </Link>
              <Link
                to="/register"
                className="bg-blue-700 text-white px-3 py-1.5 rounded-md hover:bg-blue-800 transition-colors"
              >
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
