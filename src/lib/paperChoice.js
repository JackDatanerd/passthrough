// The page size a person chose for their delivered documents (scans.paper_size, migration 0096): 'letter' or 'a4'.
// Anything else - '', 'auto', null, junk - means "not chosen": the job posting decides (design.service.js detectPaper).
const PAPER_CHOICES = ['letter', 'a4']
const cleanPaperChoice = v => { const x = String(v ?? '').trim().toLowerCase(); return PAPER_CHOICES.includes(x) ? x : null }
module.exports = { PAPER_CHOICES, cleanPaperChoice }
