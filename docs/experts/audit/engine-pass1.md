# A4 pass 1: state machine and job engine

Base `9e79fa1`. Fixes: migration 0129 (see `CHANGES-experts-audit-a4-pass1.txt` for the finding-by-finding list and the decisions taken).
Method: read `stateMachine.js`, `clock.js`, migration 0127 and the Phase 1 functions in 0124; compared with engineering spec 5, 6.2, 7 and product spec 9.3;
probed each suspicion against PGlite before calling it a finding; wrote one regression test per finding (`tests/expertRealm.auditEngine1.test.js`).
Result: 10 bugs, 3 low findings, 7 feature gaps, all fixed in this pass. Pass 2 must be an independent read with no knowledge of this list.
Not testable here: real concurrency (PGlite is single-connection; lock order was read: job, then expert, as in Phase 1), the scheduler (not built).
