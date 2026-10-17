# Prompts

Every model prompt lives here, not inside `services/claude.service.js` (which holds the calls and the guards).

| File | Used by | Guard that backs it |
|---|---|---|
| `score.js` | `scoreResumeWithAI` (two passes) | `lib/atsChecklist.js` verifies quotes, cues and years and computes the score; `lib/careerFacts.js` counts the years |
| `rewrite.js` | `rewriteResumeContent` | `detectFabrication`, `contentLost`, `inventedNumbers`, `unsupportedSkills`, `lib/rewriteStyle.js` (style, provenance, renames), `lib/skillAliases.js` |
| `letter.js` | `generateCoverLetter` | `checkLetter` (figures, names, shape, clichés, length), `checkLetterEvidence`, `applyLetterFrame` |
| `extract.js` | `parseResumeStructure`, `structureFreeformText` | `dropUngroundedFigures`, `groundCertifications`, `checkSourceSpans` |
| `constants.js` | all of the above, the guards and `evals/` | one definition of every number and list a prompt states and a guard enforces, plus the per-prompt versions |

## How each prompt works

- **Score.** Pass 1 reads only the posting and lists its requirements (cached per posting: in memory, and in KV when `PROMPT_CACHE_KV` or `RATE_LIMIT_KV` is bound, for 14 days). Pass 2 judges the resume against that fixed list. Code counts years of experience from the resume's dates and today's date, checks every "must" cue and every evidence quote, and computes the number. A reply without a usable checklist fails; it is never guessed.
- **Rewrite.** Truth first, then output, then craft. The model also returns `provenance` (which input bullets each new bullet came from) and `skillRenames`; code checks both. Whether to write a summary, the spelling (US/UK) and the level guidance are decided in code and handed to the model. The writer is never shown a score or a target, and genuine gaps are never named to it.
- **Letter.** One of three model letters (strong fit / one honest gap / early career) is chosen in code. Code writes the salutation and sign-off (no guessed "Ms."; UK letters close "Yours sincerely" / "Yours faithfully"). Gaps come from the scorer (`known_gaps`), not from the model. The model returns `{evidence, letter}`; each evidence quote is checked against the resume.
- **Extraction.** Verbatim copy for uploads; for brain dumps every bullet carries a `sourceSpan` that code checks, derived dates are never computed (a `question` is returned instead), and `warnings` / `questions` / `unverifiedBullets` / `needsConfirmation` are returned beside the data for the UI to use.

## Prompt caching (opt-in)

Set `PROMPT_CACHE=on` (a Worker var) to send each system prompt as a cache-marked block: repeat calls within a few minutes are billed at a tenth of the input price. It is OFF by default, so the request is unchanged until you turn it on. With it on, `claude_usage.input_tokens` holds billing-equivalent tokens (a cache write counts 1.25x, a read 0.1x), so the ledger cannot under-report. Check the ledger for a day before relying on the savings: at low traffic a prompt may be written to the cache more often than it is read.

## Changing a prompt

1. Edit the file. Keep the strings the tests pin (`tests/docgen.prompts.test.js`, `tests/prompts.quality.test.js`, `tests/prompts.close.test.js`).
2. Bump the matching number in `PROMPT_VERSIONS` (`constants.js`). `scans.prompt_version` is stamped with the rewrite + score + extract generations, `scans.letter_prompt_version` with the letter generation, so a change in one prompt can be told apart from a change in another in the interview-outcome numbers.
3. A new example? Put its distinctive names and tools in `evals/promptEntities.cjs`: `tests/prompts.decontam.test.js` fails if an example's entity (or any five-word phrase) also appears in a fixture.
4. `npm test` (offline), then `ANTHROPIC_API_KEY=... npm run eval:prompts` (live model, dev set; see `evals/README.md`). Run the held-out set once, before bumping the version, never while tuning.
5. Found a real failure in production? Add a fixture for it before fixing the prompt.

Rules of thumb used here: a prompt states the rule, a guard enforces it; never rely on the prompt alone for anything that touches truth or the credential. Replace rules rather than add them: a rule a guard already enforces is stated once, briefly.
