// One definition of "this wording is first person", shared by the ATS craft feedback (ats.service.js) and the rewrite style
// guard (rewriteStyle.js). "I" is also a Roman numeral ("Phase I trials", "Type I diabetes", "Series I funding"): those are
// correct resume wording, and a check that flags them sends the writer a correction for text that was fine (Scan/ATS round 12).
const ROMAN_LABELS = 'Phase|Type|Class|Series|Part|Level|Grade|Tier|Stage|Group|Chapter|Schedule|Title|Form|Category|Round|Track|Step|Wave|Cohort|War'
const FIRST_PERSON = new RegExp(String.raw`\b(?:[Mm]y|me|mine|myself)\b|\bI['’](?:m|ve|d|ll)\b|(?<!\b(?:${ROMAN_LABELS})\s)\bI\b(?!\s*[.,;:)\/&-]|\s+(?:and|or)\b|\s+[A-Z0-9])`)
module.exports = { FIRST_PERSON }
