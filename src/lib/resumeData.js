// The structured-resume shape a CLIENT is allowed to hand the server, shared by every endpoint
// that accepts one: PATCH /scan/:id/resume-data (correct a brain-dump extraction) and
// PUT /profile (correct the saved profile). It lives here, not in either controller, so the two
// can never drift apart on what "a valid resume" is or how large one may be.
//
// Deliberately permissive (`.passthrough()`): it catches a malformed body, it does not police
// every field. The AI-generation call sites do NOT run their output through this — that would
// be a second thing to keep in sync with the prompt's own schema.

const { z } = require('zod')

// A real structured resume is a few KB. Bounded BEFORE it is validated, rendered to a docx and
// stored as JSONB: the schema is permissive, so it cannot be relied on to cap size.
const MAX_RESUME_DATA_JSON_CHARS = 100_000

const resumeDataSchema = z.object({
  name:      z.string().nullable().optional(),
  email:     z.string().nullable().optional(),
  phone:     z.string().nullable().optional(),
  location:  z.string().nullable().optional(),
  linkedin:  z.string().nullable().optional(),
  portfolio: z.string().nullable().optional(),
  summary:   z.string().nullable().optional(),
  experience: z.array(z.object({
    company:  z.string().nullable().optional(),
    title:    z.string().nullable().optional(),
    dates:    z.string().nullable().optional(),
    // Where the job was (city / "Remote"). Optional; most resumes show it.
    location: z.string().nullable().optional(),
    bullets:  z.array(z.string()).optional()
  })).optional(),
  education: z.array(z.object({
    institution: z.string().nullable().optional(),
    degree:      z.string().nullable().optional(),
    dates:       z.string().nullable().optional(),
    // GPA / honours / relevant coursework, as the person wrote it.
    details:     z.string().nullable().optional()
  })).optional(),
  skills:         z.array(z.string()).optional(),
  certifications: z.array(z.string()).optional(),
  // Sections a from-scratch resume commonly needs and the schema used to have no place for
  // (anything the person wrote about them was silently dropped).
  languages:    z.array(z.string()).optional(),
  awards:       z.array(z.string()).optional(),
  publications: z.array(z.string()).optional(),
  volunteer: z.array(z.object({
    organization: z.string().nullable().optional(),
    role:         z.string().nullable().optional(),
    dates:        z.string().nullable().optional(),
    bullets:      z.array(z.string()).optional()
  })).optional(),
  projects: z.array(z.object({
    name:         z.string().nullable().optional(),
    description:  z.string().nullable().optional(),
    technologies: z.array(z.string()).optional(),
    link:         z.string().nullable().optional()
  })).optional()
}).passthrough()

// Removes empty strings the editor sends for untouched lines: blank bullets, blank skills /
// certifications / technologies (they became empty "•" lines in the delivered documents).
function dropBlankEntries(rd) {
  const keep = arr => (Array.isArray(arr) ? arr.filter(x => typeof x !== 'string' || x.trim()) : arr)
  const blank = v => (typeof v === 'string' ? !v.trim() : v == null || (Array.isArray(v) && v.length === 0))
  // An "Add job" / "Add school" row the person never filled in is an entry whose
  // every field is empty — saved as-is it printed an empty heading line (and an
  // empty-bullet block) into the delivered documents.
  const keepEntries = (arr, fields) => (Array.isArray(arr) ? arr.filter(e => e && fields.some(f => !blank(e[f]))) : arr)
  return {
    ...rd,
    skills: keep(rd.skills),
    certifications: keep(rd.certifications),
    languages: keep(rd.languages),
    awards: keep(rd.awards),
    publications: keep(rd.publications),
    volunteer: Array.isArray(rd.volunteer)
      ? keepEntries(rd.volunteer.map(v => ({ ...v, bullets: keep(v?.bullets) })), ['organization', 'role', 'dates', 'bullets']) : rd.volunteer,
    experience: Array.isArray(rd.experience)
      ? keepEntries(rd.experience.map(e => ({ ...e, bullets: keep(e?.bullets) })), ['company', 'title', 'dates', 'bullets']) : rd.experience,
    education: keepEntries(rd.education, ['institution', 'degree', 'dates', 'details']),
    projects: Array.isArray(rd.projects)
      ? keepEntries(rd.projects.map(p => ({ ...p, technologies: keep(p?.technologies) })), ['name', 'description', 'technologies', 'link']) : rd.projects,
  }
}

const text = v => (typeof v === 'string' ? v.trim() : '')

// Is there anything here worth reusing as a profile? A name alone is not a background.
function hasResumeContent(rd) {
  if (!rd || typeof rd !== 'object') return false
  const list = v => (Array.isArray(v) ? v : [])
  if (list(rd.experience).some(e => text(e?.title) || text(e?.company) || list(e?.bullets).some(text))) return true
  if (list(rd.education).some(e => text(e?.institution) || text(e?.degree))) return true
  if (list(rd.skills).some(text)) return true
  if (list(rd.volunteer).some(v => text(v?.organization) || text(v?.role))) return true
  if (['awards', 'publications', 'certifications'].some(k => list(rd[k]).some(text))) return true
  if (list(rd.projects).some(p => text(p?.name) || text(p?.description))) return true
  return !!text(rd.summary)
}

// -> { ok: true, data } | { ok: false, message }
// Postgres cannot store U+0000 in jsonb ("unsupported Unicode escape sequence"), so a NUL
// anywhere in the payload used to pass validation and then fail inside the RPC as a 500.
// Removed from every string value and key instead: it is never meaningful resume text.
function stripNul(v) {
  if (typeof v === 'string') return v.includes('\u0000') ? v.replace(/\u0000/g, '') : v
  if (Array.isArray(v)) return v.map(stripNul)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[stripNul(k)] = stripNul(val)
    return out
  }
  return v
}

function parseClientResumeData(rawInput) {
  if (JSON.stringify(rawInput ?? null).length > MAX_RESUME_DATA_JSON_CHARS)
    return { ok: false, message: 'Resume data is too large.' }
  const input = stripNul(rawInput)
  const parsed = resumeDataSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Resume data is not in the expected shape.' }
  return { ok: true, data: dropBlankEntries(parsed.data) }
}

module.exports = { stripNul, MAX_RESUME_DATA_JSON_CHARS, resumeDataSchema, dropBlankEntries, hasResumeContent, parseClientResumeData }
