// How the contact details of a resume or letter are laid out, shared by the DOCX and the PDF so both break the same way.
// One line when it fits (about 100 characters at the header's size, separators included). Longer, and a single line wrapped
// in the middle of a LinkedIn URL ("linkedin.com/in/" / "wanjirumwangi-data-analyst"), so it becomes two deliberate rows:
// how to reach the person (email, phone, location), then where to find them (profile and portfolio links).
const MAX_ONE_LINE = 100

/** rows([{ text, link, group: 'details' | 'links' }]) -> array of 1 or 2 arrays of items (empty items are dropped) */
function contactRows(items) {
  const list = (Array.isArray(items) ? items : []).filter(i => i && typeof i.text === 'string' && i.text.trim())
  if (!list.length) return []
  const total = list.map(i => i.text).join(' | ').length
  const details = list.filter(i => i.group !== 'links'), links = list.filter(i => i.group === 'links')
  if (total <= MAX_ONE_LINE || !details.length || !links.length) return [list]
  return [details, links]
}

// The order and grouping of the fields; `link: false` = never a link (the location).
const contactItems = d => [[d?.email, true, 'details'], [d?.phone, true, 'details'], [d?.location, false, 'details'], [d?.linkedin, true, 'links'], [d?.portfolio, true, 'links']]
  .map(([v, link, group]) => ({ text: typeof v === 'string' ? v.trim() : '', link, group }))
  .filter(i => i.text)

module.exports = { contactRows, contactItems, MAX_ONE_LINE }
