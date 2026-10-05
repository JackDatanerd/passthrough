import { Link } from 'react-router-dom'
import Input from '../ui/Input'
import Select from '../ui/Select'
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
      <Select id="lead-role-category" aria-label="Field you are hiring in" value={category} onChange={e => onCategory(e.target.value)}>
        <option value="">What field are you hiring in? (optional)</option>
        {ROLE_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <Input placeholder="Job title (optional, e.g. Senior Engineer)" value={title} maxLength={100}
        onChange={e => onTitle(e.target.value)} />
    </>
  )
}

// What a visitor is told after submitting. The API answers every valid submission the same
// way on purpose (so the form can't be used to learn who is on the list), which means the
// copy must not promise an email: none is sent for an address that is already confirmed,
// was removed, or was mailed moments ago.
export const LEAD_SENT_MESSAGE =
  "Thanks — if this address isn't already on our list, we've emailed you a link to confirm it. Check your inbox (and spam folder). Once you've confirmed, we'll reach out when we have candidates matching your needs."

// What submitting does, said where it happens.
export function LeadConsentNote() {
  return (
    <p className="text-xs text-gray-500">
      We'll email you when there are Verified candidates in your field. If this address is new to us we'll first send a link to confirm it.{' '}
      <Link to="/privacy" className="underline">Privacy</Link>
    </p>
  )
}
