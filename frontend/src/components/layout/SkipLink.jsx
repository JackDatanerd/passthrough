// "Skip to content" link shared by every layout (Navbar, DashboardLayout, AdminLayout). It moves keyboard focus past the header
// into the page's <main> so nobody tabs through the whole navigation on every page. Each layout used to carry its own copy of the
// handler (and the admin console had none at all). Visible only while focused.
export function skipToMain(e) {
  const main = document.querySelector('main')
  if (!main) return
  e.preventDefault()
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
  main.focus()
  main.scrollIntoView?.()
}

export default function SkipLink() {
  return (
    <a
      href="#main"
      onClick={skipToMain}
      className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-blue-700 focus:shadow-lg focus:ring-2 focus:ring-blue-500"
    >
      Skip to content
    </a>
  )
}
