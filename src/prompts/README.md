# Prompts

Every model prompt lives here, not inside `services/claude.service.js` (which holds the calls and the guards).

| File | Used by | Guard that backs it |
|---|---|---|
| `score.js` | `scoreResumeWithAI` | `lib/atsChecklist.js` computes the score and verifies quotes |
| `rewrite.js` | `rewriteResumeContent` | `detectFabrication`, `contentLost`, `inventedNumbers`, `unsupportedSkills`, `lib/rewriteStyle.js` |
| `letter.js` | `generateCoverLetter` | `checkLetter` (figures, names, shape, clichés, length) |
| `extract.js` | `parseResumeStructure`, `structureFreeformText` | `dropUngroundedFigures`, `groundCertifications` |

## Changing a prompt

1. Edit the file. Keep the strings the tests pin (`tests/docgen.prompts.test.js`, `tests/prompts.quality.test.js`).
2. Bump `PROMPT_VERSION` in `claude.service.js` (it is stamped on every delivered fix and letter).
3. `npm test` (offline), then `ANTHROPIC_API_KEY=... npm run eval:prompts` (live model over `evals/fixtures.cjs`).
4. Found a real failure in production? Add a fixture for it before fixing the prompt.

Rules of thumb used here: a prompt states the rule, a guard enforces it; never rely on the prompt alone for anything that touches truth or the credential.
