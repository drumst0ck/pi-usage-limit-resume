# review-hardening
Fixes from the blind dual review (judges A and B) of a753c8d. Corroborated findings first.
Read until `## Log`.

## Specs
- S1 `/limit-resume now` must not be re-held: it drops the saved cooldown like cancel (JD-A-001, JD-B-004).
- S2 A dismissal (cancel/now) persists in the state dir and tolerates reset instants from other sources (up to 5 min later), so another process or a restart does not re-create it from a stale 100% window (JD-A-011, JD-B-005).
- S3 Release on fresh windows happens at most once per limit episode: a limit hit again within 15 min of a release, or a model-specific limit ("opus limit", "sonnet limit"), is stored as non-releasable (JD-A-002, JD-B-002).
- S4 A release check that finishes after cancel/abort changes nothing and says nothing (JD-A-003, JD-B-008).
- S5 A waiting process notices a cooldown cleared or shortened by another process within one tick (JD-A-005).
- S6 A cooldown beyond 8 days never silently aborts messages; saved monthly windows do not hold messages preflight (JD-B-001, JD-A-004). A month/day reset that passed less than 36 h ago is not rolled to next year (JD-A-006).
- S7 A successful response on a family clears its cooldown (proof of capacity) (JD-B-003).
- S8 A 5xx number only means "transient" in HTTP status context (JD-A-008, JD-B-007).
- S9 The notice says "next retry at … (reset time unknown)" for probes; the status line names family, time/date and `/limit-resume cancel`; each held message is announced (JD-B-006, JD-B-012, JD-A-013).
- S10 History is appended (O_APPEND), trimmed to 50 (JD-A-009, JD-B-010).

- S11 A wait interrupted by closing Pi is resumed when that session is opened again: Pi says it continues at the reset, then sends the resume prompt. A message typed meanwhile replaces it; cancel/now and RPC children skip it.
- S12 Resets with zone abbreviations (PST, EDT, CET, GMT+2, UTC-5) and 24-hour times ("resets 19:00") parse correctly; an unknown zone yields no reset (probe or native source decide).
- S13 Expired or corrupt cooldown files of every family are removed at session start.
- S14 An unwritable state dir never breaks a message or a wait: cooldowns fall back to memory and the user is told once.
- S15 Giving up after too many consecutive limits says what happens next (cooldown kept until <time>, cancel clears it).
- S16 History rotation loses no concurrent event: past 100 lines the file is renamed to limit-history.1.jsonl.
- S17 Esc cannot end a hold in Pi 1.2.0 (no ctx.signal in boundaries; isIdle stays false; abort flags are private): documented in README; the status line and notices name /limit-resume cancel (JD-B-001).
- S18 Chat notices never trigger a turn: sendMessage with triggerTurn:false (JD-A-001).
- S19 Monthly windows never set a wait nor veto a release; the shortest exhausted window explains a limit (JD-A-002).
- S20 A model-specific (noRelease) cooldown records the model; a message on another model of the family is not held by it (JD-B-003).
- S21 The release check during a wait respects the shared window refresh throttle (15 min claude, 5 min others) (JD-B-004).
- S22 A success clears the cooldown only when the model is on a plan (JD-A-005).
- S23 Compact durations ("6m0s", "2h13m", "after 30 seconds", "reset after 3h31m59s") and "5-hour limit reached" are detected (JD-A-004, JD-B-002).
- S24 ET/PT/CT/MT map to IANA zones; the first parseable "resets …" wins when an earlier one is not a time (JD-B-008, JD-A-010).
- S25 A dismissal from another process stops the other waiters (no resume prompt); a release or success resumes them (JD-B-006).
- S26 A pending resume survives an abort followed by session_shutdown (/new, /resume) (JD-A-007); when the reset is long past (> 1h) it only notifies and does not auto-send (JD-B-005); it honours a dismissal (JD-A-008).
- S27 `now` during a preflight hold forces the retry without a second resume prompt (JD-B-009).
- S28 README: status line text, resume-<sessionId>.json, Esc note (JD-B-010, JD-A-011).

## Tasks
- T1 S1,S2 inline [x]
- T2 S3,S4,S5,S7 inline [x]
- T3 S6 inline [x]
- T4 S8,S9,S10 inline [x]
(one commit, recorded in Log)
- T5 S11 inline [x] b2dd573
- T6 S12 inline [x] 6695bb5
- T7 S13-S16 inline [x] 033f291
- T8 S17,S18,S27 inline
- T9 S19,S20,S21,S22,S25 inline
- T10 S23,S24 inline
- T11 S26,S28 inline

## Log
- L1 "usa opues 5.5 como orquestador para revisar todo esto buscar posibles errores y bugs y mejorar el producto"
- L2 Judges A and B ran on a753c8d; 28 rows, corroborated set above. Not addressed: JD-B-011 (zone abbreviations, 24h), JD-A-010 (gc of other families), JD-B-009 (state-dir errors), JD-A-014 (MAX_CONSECUTIVE wording).
- L3 RED observed for 15 new tests; GREEN 288/288 + typecheck. CLI fixture test moved to a future date (old fixed date now parses as just-passed per S6).
- L4 Verify: S1-S10 met (288/288); fixed W1 (success keeps noRelease cooldown), W3 (probe label by own instant), README nit. 289/289. Commit b0603b5.
- L5 "sigue con lo pendiente": open items from L2/L4 become S11-S16.
- L6 RED observed per task; verify: S11,S13,S15 met; S12/S14/S16 partial -> fixed W1 (lowercase word not a zone, unknown uppercase bare zone -> no reset), W2 (memory wins over stale files, failed deletes hidden), W3 (rotation ENOENT not a failure) in 1c568cf. 303/303 + typecheck. Not done: two-process rotation test, W4 shuttingDown single flag (not reproduced).
- L7 "busca posibles bugs y fallos": judges round 2 on da98990, 22 rows; Pi 1.2.0 source confirmed: no ctx.signal in boundaries (agent.signal = activeRun?.signal), sendMessage steers while streaming and hasQueuedMessages forces continue, teardownCurrent aborts before session_shutdown. Declined: JD-A-006 (ctx.mode; argv kept, documented), JD-A-003 (gemini per-model buckets: follow-up), JD-B-011 (rotation race: diagnostic only).
