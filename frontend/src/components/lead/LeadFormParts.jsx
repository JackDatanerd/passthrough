import { Link } from 'react-router-dom'
import Input from '../ui/Input'
import { ROLE_CATEGORIES } from '../../lib/roleCategories'

// The role part of the employer early-access form, shared by the homepage and
// the verification page. The dropdown is the taxonomy candidates' scans are
// tagged with — that shared vocabulary is what lets a lead be matched against
// verified candidates — and the optional title is the free-text job title
// (the API keeps them in separate columns). The verification page used to ask
// for one free-text box instead, so any manager who typed their own title got
// a lead with no field, which can never be matched.
export function RoleFields({ category, onCategory, title, onTitle }) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor="lead-role-category" className="sr-only">Field you are hiring in</label>
        <select id="lead-role-category" value={category} onChange={e => onCategory(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700">
          <option value="">What field are you hiring in? (optional)</option>
          {ROLE_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <Input placeholder="Job title (optional, e.g. Senior Engineer)" value={title} maxLength={100}
        onChange={e => onTitle(e.target.value)} />
    </>
  )
}

// What submitting does, said where it happens.
export function LeadConsentNote() {
  return (
    <p className="text-xs text-gray-500">
      We'll email you when there are Verified candidates in your field, and send one confirmation now.{' '}
      <Link to="/privacy" className="underline">Privacy</Link>
    </p>
  )
}
