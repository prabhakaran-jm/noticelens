# NoticeLens follow-ups after Milestone 1

This note is not a product screen. Milestone 1 stays on the deterministic domain core and the security fixes already on `feat/m1-deterministic-domain-core`. The items below are outstanding. They are not implemented here.

Independent review of `5f2f9d0` is **merge with documented deferments**. O10 nested placeholders and the name-component substring false positives are verified fixed. `npm test` passed 83/83, and typecheck and build passed. The additional regressions below are not reachable through the shipped UI. Recording them is not a claim that personal data is guaranteed to be removed. Pattern checks do not prove that.

## Documented deferments from the `5f2f9d0` review

### N-1 Contextual name leakage

`isAmbiguousDomainUse` uses a surrounding text window rather than the exact occurrence. A known personal name such as Bill or Energy can survive redaction and validation when a nearby sentence contains a domain phrase. Reproductions M07–M09. Severity: Medium. Gate: **must fix before Milestone 2 enables cloud submission of edited or redacted notices.** This is a hard blocker for Milestone 2 cloud integration, not an optional improvement.

### N-2 Compact name matching regression

Known names containing zero-width characters or letter spacing can bypass the final cloud guard. The compact-name check is skipped for some name cases. Reproductions G16, G19c, Z1, Z2. Severity: Medium. Gate: **must fix before Milestone 2 enables cloud submission of edited or redacted notices.** This is a hard blocker for Milestone 2 cloud integration, not an optional improvement.

### N-3 Short and compound name limitations

Two-letter names, curly apostrophes, and hyphenated given-name components are not consistently protected. Reproductions M16, M18, M23. Gate: improve detection and document the limitations that remain before a public demo.

### N-4 Common-word over-redaction

Names such as Will or June can corrupt meaningful billing statements. Reproductions M24, M25. Gate: Milestone 2 source evidence and clause accuracy validation.

### N-5 Nonstandard placeholders

Bare or unconventional placeholder forms can remain unblocked. Gate: Milestone 2 copy/download and output validation review.

## Clarifications

- Cloud-output invented-identifier detection still requires strengthening.
- The benchmark still relies on the old short-quote verifier.
- Real-Chrome request-body inspection is mandatory before the public demo.
- N-1 and N-2 are hard blockers for Milestone 2 cloud integration. They are not optional future improvements.
- No statement in this repository may claim that personal data is guaranteed to have been removed.

## Milestone 2

Milestone 2 cloud submission of edited or redacted notices stays blocked until N-1 and N-2 are fixed.

- Ground source facts by role, with evidence for the whole clause rather than a matching fragment. The benchmark still uses the old short-quote verifier.
- Require an explicit Privacy modal approval that is bound to the canonical cloud payload.
- Stop the legacy Milestone 0 spike from displaying facts that are not supported by the source.
- Block Copy and Download in the user interface while any placeholder is unresolved or malformed. The domain flag exists; the screens do not enforce it yet.
- Integrate the four approved screens for real, in place of the spike harness.

## Milestone 4

- Inspect network request bodies in real Chrome before the public demo. Mocked calls do not satisfy that gate.
- Add a content security policy.
- Strengthen cloud-output checks, including invented-identifier detection and conditional legal language.
- Replace the benchmark's old short-quote verifier and broaden the fixtures.

## Deferred

These items are not implemented here:

- On-device inference timeout.
- Residual PII detection limitations, including unusual names, addresses, and Unicode homoglyphs.
- Production test-injection seam review and restriction.
- Dead raw-embed guard.
- Source role grounding and truncated evidence.
- Cloud output legal-conclusion validation.
- False positives in grouped number detection.
- Bracketed instructional text versus supported placeholder tokens.
- Real Chrome request-body audit.
- Content Security Policy, and removal of the legacy SpikeHarness before a demo.

Inference mode, the cloud model `gemini-3.5-flash-lite`, App Check, and the canonical immutable cloud snapshot stay as they are.
