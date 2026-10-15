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

## Tasks
- T1 S1,S2 inline [x]
- T2 S3,S4,S5,S7 inline [x]
- T3 S6 inline [x]
- T4 S8,S9,S10 inline [x]
(one commit, recorded in Log)
- T5 S11 inline
- T6 S12 inline
- T7 S13-S16 inline

## Log
- L1 "usa opues 5.5 como orquestador para revisar todo esto buscar posibles errores y bugs y mejorar el producto"
- L2 Judges A and B ran on a753c8d; 28 rows, corroborated set above. Not addressed: JD-B-011 (zone abbreviations, 24h), JD-A-010 (gc of other families), JD-B-009 (state-dir errors), JD-A-014 (MAX_CONSECUTIVE wording).
- L3 RED observed for 15 new tests; GREEN 288/288 + typecheck. CLI fixture test moved to a future date (old fixed date now parses as just-passed per S6).
- L4 Verify: S1-S10 met (288/288); fixed W1 (success keeps noRelease cooldown), W3 (probe label by own instant), README nit. 289/289. Commit b0603b5.
- L5 "sigue con lo pendiente": open items from L2/L4 become S11-S16.
