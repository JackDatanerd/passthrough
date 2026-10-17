// A valid scorer-model reply (requirement checklist) plus the resume and posting it is valid FOR: the scorer discards
// requirements that are not in the posting and downgrades quotes that are not in the resume, so a mock reply must match
// the texts it is scored against.
export const JD_TEXT = 'Operations Analyst. Required: SQL, vendor management and weekly reporting. Nice to have: Tableau dashboards. 3+ years of experience.'
export const RESUME_TEXT = 'Jane Doe. Operations Analyst at Acme. Wrote SQL queries to build weekly reporting for regional managers. Managed vendor relationships for the logistics team. Skills: SQL, Excel, Tableau.'
export const CHECKLIST = {
  requirements: [
    { requirement: 'SQL', priority: 'must', status: 'met', evidence: 'Wrote SQL queries to build weekly reporting' },
    { requirement: 'vendor management', priority: 'must', status: 'met', evidence: 'Managed vendor relationships for the logistics team' },
    { requirement: 'weekly reporting', priority: 'must', status: 'met', evidence: 'weekly reporting for regional managers' },
    { requirement: 'Tableau dashboards', priority: 'nice', status: 'partial', evidence: 'Tableau' },
  ],
  seniority: 'match',
  title: 'strong',
}
export const CHECKLIST_TEXT = JSON.stringify(CHECKLIST)
