# Prompt evals

Offline checks run in `npm test` (they cost nothing). The live run calls the real model and costs tokens, so it is a manual gate:
run it after ANY change under `src/prompts/` or to a guard, and before bumping a version in `src/prompts/constants.js`.

## What is here

| File | What it is |
|---|---|
| `fixtures.cjs` | 40 fixtures: US and UK, Western names (one Cyrillic name for the unicode case), `set: 'dev'` or `'holdout'`, each with the level/title/steering a real call site passes |
| `checks.cjs` | the property checks (gaps, length, level preserved, no extra bullets, skills/renames, locale spelling, letter shape/honorific/gaps, opening diversity, score spread, verdict flips, requirement-list agreement, gold scoring) |
| `gold.cjs` | 8 hand-labelled extraction cases (labels written by the prompt author: review them and add real failures) |
| `judge.cjs` | pairwise LLM judge, original vs rewrite, both orders |
| `judge-calibration.json` | where YOU put 20+ pairs you have judged, so the judge can be checked against a person |
| `promptEntities.cjs` | names/tools used in the prompts' own examples (kept out of every fixture) |
| `baseline.json` | written by `--update-baseline`; later runs fail on a regression against it |

## Commands

```
npm run eval:prompts                          dev set, 5 score runs per fixture
npm run eval:prompts -- --set holdout         held-out set (before a version bump only)
npm run eval:prompts -- --set all --judge     everything, plus the judge win-rate
npm run eval:prompts -- --gold                extraction vs gold
npm run eval:prompts -- --calibrate           judge vs your labels (needs 20+ labelled pairs and 80%+ agreement)
npm run eval:prompts -- --update-baseline     record this run as the baseline
npm run eval:dry                              no key, no cost: a canned fake model exercises the harness (wiring only)
flags: --only <id>  --runs N  --model <name>  --json <file>
```

About 15-20 API calls per fixture (`--runs 3` and `--only` are the cheap ways to iterate). Compare models by running with `--model`
and reading the aggregates.

## The bar ("A")

| Measure | Target |
|---|---|
| fabricated gaps, any output | 0 |
| AI score spread over the runs | 2 points or less |
| requirement-list agreement across runs | 0.85 or better |
| verdict flips at the pass or credential line | 0 |
| first-pass-clean rewrites (no corrective pass) | 90%+ |
| letter opening duplication | 20% or less |
| extraction on gold: F1 / hallucinated / verbatim bullets | 0.90+ / 0 / 98%+ |
| judge win-rate, rewrite vs original | 85%+ (only meaningful once calibrated) |

The judge numbers are uncalibrated until `--calibrate` passes against pairs you have labelled. Without that they are a signal, not a measurement.
