import CsvInput from './CsvInput'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'

// The editable fields of a structured resume, shared by every place a person corrects one:
// the scan-result editor (ResumeDataEditor) and the saved-profile editor in Settings
// (SavedProfileEditor). One copy, so the two can never offer different fields or drop different
// ones. Controlled by the parent: `draft` is the parent's working copy, `setDraft` its setter.
export default function ResumeFieldsForm({ draft, setDraft }) {
  function updateField(field, value) {
    setDraft(prev => ({ ...prev, [field]: value }))
  }

  function updateListItem(section, index, field, value) {
    setDraft(prev => {
      const list = [...(prev[section] || [])]
      list[index] = { ...list[index], [field]: value }
      return { ...prev, [section]: list }
    })
  }

  function addListItem(section, blank) {
    setDraft(prev => ({ ...prev, [section]: [...(prev[section] || []), blank] }))
  }

  function removeListItem(section, index) {
    setDraft(prev => ({ ...prev, [section]: (prev[section] || []).filter((_, i) => i !== index) }))
  }

  return (
    <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Name"     value={draft.name     || ''} onChange={e => updateField('name', e.target.value)} />
            <Input label="Email"    value={draft.email    || ''} onChange={e => updateField('email', e.target.value)} />
            <Input label="Phone"    value={draft.phone    || ''} onChange={e => updateField('phone', e.target.value)} />
            <Input label="Location" value={draft.location || ''} onChange={e => updateField('location', e.target.value)} />
            <Input label="LinkedIn"  value={draft.linkedin  || ''} onChange={e => updateField('linkedin', e.target.value)} placeholder="linkedin.com/in/you" />
            <Input label="Portfolio / GitHub" value={draft.portfolio || ''} onChange={e => updateField('portfolio', e.target.value)} placeholder="yoursite.com" />
          </div>
          <Textarea label="Summary" rows={3} value={draft.summary || ''} onChange={e => updateField('summary', e.target.value)} />

          <EditSection
            title="Experience"
            items={draft.experience || []}
            onAdd={() => addListItem('experience', { company: '', title: '', dates: '', location: '', bullets: [] })}
            onRemove={i => removeListItem('experience', i)}
            renderItem={(item, i) => (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                <Input placeholder="Company" value={item.company || ''} onChange={e => updateListItem('experience', i, 'company', e.target.value)} />
                <Input placeholder="Title"   value={item.title   || ''} onChange={e => updateListItem('experience', i, 'title', e.target.value)} />
                <Input placeholder="Dates (e.g. Jan 2022 – Present)" value={item.dates || ''} onChange={e => updateListItem('experience', i, 'dates', e.target.value)} />
                <Input className="sm:col-span-3" placeholder="Location (optional, e.g. Nairobi or Remote)" value={item.location || ''} onChange={e => updateListItem('experience', i, 'location', e.target.value)} />
                <Textarea
                  className="sm:col-span-3"
                  rows={4}
                  placeholder="One bullet per line"
                  value={(item.bullets || []).join('\n')}
                  onChange={e => updateListItem('experience', i, 'bullets', e.target.value.split('\n'))}
                />
              </div>
            )}
          />

          <EditSection
            title="Education"
            items={draft.education || []}
            onAdd={() => addListItem('education', { institution: '', degree: '', dates: '', details: '' })}
            onRemove={i => removeListItem('education', i)}
            renderItem={(item, i) => (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                <Input placeholder="Institution" value={item.institution || ''} onChange={e => updateListItem('education', i, 'institution', e.target.value)} />
                <Input placeholder="Degree"      value={item.degree      || ''} onChange={e => updateListItem('education', i, 'degree', e.target.value)} />
                <Input placeholder="Dates"       value={item.dates       || ''} onChange={e => updateListItem('education', i, 'dates', e.target.value)} />
                <Input className="sm:col-span-3" placeholder="GPA, honours, relevant coursework (optional)" value={item.details || ''} onChange={e => updateListItem('education', i, 'details', e.target.value)} />
              </div>
            )}
          />

          <EditSection
            title="Projects"
            items={draft.projects || []}
            onAdd={() => addListItem('projects', { name: '', description: '', technologies: [], link: null })}
            onRemove={i => removeListItem('projects', i)}
            renderItem={(item, i) => (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                <Input placeholder="Project name" value={item.name || ''} onChange={e => updateListItem('projects', i, 'name', e.target.value)} />
                <CsvInput placeholder="Technologies (comma-separated)" value={item.technologies}
                  onChange={arr => updateListItem('projects', i, 'technologies', arr)} />
                <Textarea className="sm:col-span-2" rows={2} placeholder="What it does / your role"
                  value={item.description || ''} onChange={e => updateListItem('projects', i, 'description', e.target.value)} />
                <Input className="sm:col-span-2" placeholder="Link (optional)" value={item.link || ''} onChange={e => updateListItem('projects', i, 'link', e.target.value)} />
              </div>
            )}
          />

          <EditSection
            title="Volunteer experience"
            items={draft.volunteer || []}
            onAdd={() => addListItem('volunteer', { organization: '', role: '', dates: '', bullets: [] })}
            onRemove={i => removeListItem('volunteer', i)}
            renderItem={(item, i) => (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                <Input placeholder="Organization" value={item.organization || ''} onChange={e => updateListItem('volunteer', i, 'organization', e.target.value)} />
                <Input placeholder="Role"         value={item.role         || ''} onChange={e => updateListItem('volunteer', i, 'role', e.target.value)} />
                <Input placeholder="Dates"        value={item.dates        || ''} onChange={e => updateListItem('volunteer', i, 'dates', e.target.value)} />
                <Textarea
                  className="sm:col-span-3"
                  rows={3}
                  placeholder="One bullet per line"
                  value={(item.bullets || []).join('\n')}
                  onChange={e => updateListItem('volunteer', i, 'bullets', e.target.value.split('\n'))}
                />
              </div>
            )}
          />

          <CsvInput label="Skills (comma-separated)" value={draft.skills} onChange={arr => updateField('skills', arr)} />
          <CsvInput label="Certifications (comma-separated)" value={draft.certifications} onChange={arr => updateField('certifications', arr)} />
          <CsvInput label="Languages (comma-separated)" value={draft.languages} onChange={arr => updateField('languages', arr)} />
          {/* One per line, not comma-separated: award and publication titles contain commas. */}
          <Textarea label="Awards & honours (one per line)" rows={2} value={(draft.awards || []).join('\n')}
            onChange={e => updateField('awards', e.target.value.split('\n'))} />
          <Textarea label="Publications (one per line)" rows={2} value={(draft.publications || []).join('\n')}
            onChange={e => updateField('publications', e.target.value.split('\n'))} />
    </>
  )
}

function EditSection({ title, items, onAdd, onRemove, renderItem }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-medium text-gray-700">{title}</p>
        <button type="button" onClick={onAdd} className="text-xs text-blue-600 hover:underline">+ Add</button>
      </div>
      {items.length === 0 && <p className="text-xs text-gray-400 mb-2">Nothing here yet.</p>}
      {items.map((item, i) => (
        <div key={i} className="border border-gray-200 rounded-md p-3 mb-2 relative">
          {renderItem(item, i)}
          <button type="button" onClick={() => onRemove(i)}
            className="absolute top-2 right-2 text-xs text-red-500 hover:underline">Remove</button>
        </div>
      ))}
    </div>
  )
}

