import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './useAuth'
import { askDiscardUnsaved, SIGN_OUT_MESSAGE } from '../lib/unsavedGuard'

// "Sign out" for the two headers (Navbar, DashboardLayout). Signing out wipes the session AND the local drafts, so when an
// editor on this page holds unsaved work the person is asked FIRST and a "Stay" answer leaves everything as it was.
// Doing it the other way round (logout(), then navigate() into the route blocker) signed them out before asking.
export default function useSignOut() {
  const { logout } = useAuth()
  const navigate = useNavigate()
  return useCallback(async () => {
    // Asked in the app's own dialog (lib/unsavedGuard) rather than window.confirm, which a browser can suppress.
    if (!(await askDiscardUnsaved(SIGN_OUT_MESSAGE, { confirmLabel: 'Sign out', cancelLabel: 'Stay' }))) return
    logout()
    navigate('/')
  }, [logout, navigate])
}
