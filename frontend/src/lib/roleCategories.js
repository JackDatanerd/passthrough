// The role taxonomy, as [key, label] pairs, for every form and filter that
// speaks it. The keys are the backend's ROLE_CATEGORIES (src/config/constants.js)
// — the same vocabulary a candidate's scan is tagged with, which is what lets
// an employer lead be matched against verified candidates. Frontend and
// backend are separate deployables with no shared package, so tests/
// roleCategories.test.js fails if the two lists ever drift apart.
export const ROLE_CATEGORIES = [
  ['software_engineering', 'Software Engineering'], ['product_management', 'Product Management'],
  ['design', 'Design'], ['data_science', 'Data Science'], ['marketing', 'Marketing'],
  ['sales', 'Sales'], ['operations', 'Operations'], ['finance', 'Finance'],
  ['healthcare', 'Healthcare'], ['legal', 'Legal'], ['education', 'Education'], ['other', 'Other'],
]

const LABELS = Object.fromEntries(ROLE_CATEGORIES)

export const isRoleCategory = (key) => Object.prototype.hasOwnProperty.call(LABELS, key)

// A taxonomy key -> its label; anything else (null, legacy free text) is
// humanised so it still reads sensibly rather than showing "software_engineering".
export function roleLabel(key) {
  if (!key) return ''
  if (isRoleCategory(key)) return LABELS[key]
  return String(key).replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
}
