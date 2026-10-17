// Distinctive names and tools that appear in the PROMPTS' OWN EXAMPLES. None may appear in any eval fixture or gold case:
// an example the eval also contains measures whether the model remembers the prompt, not whether it can do the work
// (tests/prompts.decontam.test.js holds this line, and fails if an entity here no longer appears in a prompt, so the list
// cannot rot). When you add or change a prompt example, add its new entities here.
module.exports = {
  ENTITIES: [
    // score.js
    'Accounts Receivable', 'NetSuite', 'QuickBooks', 'Power BI',
    // rewrite.js
    'Airflow', 'Flutter', 'sous chef', 'AngularJS', 'surgical ward', '30-bed',
    // letter.js
    'Priya Raman', 'Daniel Whitaker', 'Megan Frost', 'Tom Reyes', 'Kestrel Bank', 'Lowell & Finch', 'Greenmoor', 'Fenwick Civils',
    // extract.js
    'Brightside Dental', 'Dentrix', 'The Anchor',
  ],
}
