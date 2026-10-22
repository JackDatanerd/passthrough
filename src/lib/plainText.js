// The resume as plain text, for the places that still want a pasted resume (an employer portal's text box, an email body, a
// parser that only reads .txt). Same section order as the DOCX and the PDF, same date format, "- " bullets, comma-separated skills,
// no layout characters: what is pasted is what an ATS reads. A pure function of the data.
const { canonDates } = require('./dateFormat')
const { stripBullet } = require('./bulletText')

const list = v => (Array.isArray(v) ? v : [])
const str = v => (typeof v === 'string' ? v.trim() : '')

function resumeToPlainText(data) {
  const d = data && typeof data === 'object' ? data : {}
  const out = []
  const block = (title, lines) => { const l = lines.filter(Boolean); if (l.length) out.push('', title, ...l) }
  const bullets = items => list(items).map(str).filter(Boolean).map(b => `- ${stripBullet(b)}`)
  const head = parts => parts.map(str).filter(Boolean).join(' - ')

  if (str(d.name)) out.push(str(d.name))
  const contact = [d.email, d.phone, d.location, d.linkedin, d.portfolio].map(str).filter(Boolean)
  if (contact.length) out.push(contact.join(' | '))
  if (str(d.summary)) block('PROFESSIONAL SUMMARY', [str(d.summary)])

  const jobs = list(d.experience).flatMap(j => [head([j?.title, j?.company, j?.location]) + (str(j?.dates) ? ` | ${canonDates(str(j.dates))}` : ''), ...bullets(j?.bullets)])
  const edu = list(d.education).flatMap(e => [head([e?.degree, e?.institution]) + (str(e?.dates) ? ` | ${canonDates(str(e.dates))}` : ''), str(e?.details)])
  const projects = list(d.projects).flatMap(p => [head([p?.name, list(p?.technologies).map(str).filter(Boolean).join(', ')]), str(p?.description) ? `- ${stripBullet(str(p.description))}` : '', str(p?.link)])
  const volunteer = list(d.volunteer).flatMap(v => [head([v?.role, v?.organization]) + (str(v?.dates) ? ` | ${canonDates(str(v.dates))}` : ''), ...bullets(v?.bullets)])
  const skills = list(d.skills).map(str).map(stripBullet).filter(Boolean)
  const langs = list(d.languages).map(str).map(stripBullet).filter(Boolean)

  const sections = {
    experience: () => block('EXPERIENCE', jobs),
    projects: () => block('PROJECTS', projects),
    education: () => block('EDUCATION', edu),
    skills: () => block('SKILLS', [skills.join(', ')]),
    certifications: () => block('CERTIFICATIONS', bullets(d.certifications)),
    volunteer: () => block('VOLUNTEER EXPERIENCE', volunteer),
    awards: () => block('AWARDS', bullets(d.awards)),
    publications: () => block('PUBLICATIONS', bullets(d.publications)),
    languages: () => block('LANGUAGES', [langs.join(', ')]),
  }
  // Same order as the DOCX: with job history Experience leads; without, Education and Projects do.
  const order = list(d.experience).length
    ? ['experience', 'projects', 'education', 'skills', 'certifications', 'volunteer', 'awards', 'publications', 'languages']
    : ['education', 'projects', 'volunteer', 'skills', 'certifications', 'awards', 'publications', 'languages']
  for (const k of order) sections[k]()
  return out.join('\n').trim() + '\n'
}

module.exports = { resumeToPlainText }
