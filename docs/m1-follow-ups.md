# NoticeLens follow-ups after Milestone 1

This note is not a product screen. Milestone 1 stays on the deterministic domain core and the security fixes already on `feat/m1-deterministic-domain-core`. N-1 and N-2 are fixed for the reproductions named below, and M2A-2 is fixed in the Milestone 2A follow-up. M2B-1a is fixed for the soft-hyphen reproduction Z6. The other items remain outstanding.

Independent review of `5f2f9d0` is **merge with documented deferments**. O10 nested placeholders and the name-component substring false positives are verified fixed. `npm test` passed 83/83, and typecheck and build passed. The additional regressions below are not reachable through the shipped UI. Recording them is not a claim that personal data is guaranteed to be removed. Pattern checks do not prove that.

## Documented deferments from the `5f2f9d0` review

### N-1 Contextual name leakage — fixed for the documented cases

`isAmbiguousDomainUse` used a surrounding text window rather than the exact occurrence. A known personal name such as Bill or Energy could survive redaction and validation when a nearby sentence contained a domain phrase. Reproductions M07–M09. Severity was Medium.

Milestone 2A checks the matched token itself. Those documented cases are fixed: a person named Bill or Energy is protected when the name stands alone, including beside “bill” or “energy supply”, and ordinary phrases such as “billing”, “annual”, “problem”, and “energy billing” are not treated as those names. This is not a claim that every personal identifier is removed.

### N-2 Compact name matching regression — fixed for the documented cases

Known names containing zero-width characters or letter spacing could bypass the final cloud guard because the compact-name check was skipped for some name cases. Reproductions G16, G19c, Z1, Z2. Severity was Medium.

Milestone 2A restores that compact check for those reproductions. Later reproductions Z4 and Z8 are a separate gap; see M2A-1. This is not a claim that every personal identifier is removed.

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
- N-1 and N-2 are fixed for the reproductions named above. Z4 and Z8 are recorded under M2A-1. The soft-hyphen case Z6 is recorded under M2B-1a. Live cloud submission stays closed.
- No statement in this repository may claim that personal data is guaranteed to have been removed.

## Milestone 2A review

Claude Opus 5.5 reviewed `2ae6cb8` as merge with documented deferments. The follow-up patch on `feat/m2-production-ui` addresses M2A-2. Live notice-to-cloud drafting stays disabled. These notes do not claim that personal data is guaranteed to have been removed.

### M2A-1 — Medium — fixed for Z4 and Z8

Fullwidth and NFD single-name components could bypass identifier matching. Reproductions Z4 and Z8. Milestone 2B-1 uses one NFKC fold for detection, redaction, and the final payload guard, and maps each folded match back to the original span. This is not a claim that every personal identifier is removed.

### M2A-2 — Medium — fixed for the reviewed case

A model-generated action such as “Attend a court hearing about this debt” was shown as an Action Plan heading with a “Verified in notice” badge when the quotation merely occurred in the notice. The heading is now the deterministic action-summary label. That label is verified only when the quotation contains the action words that select it. An exact quote match alone does not confer a verified status. Unsupported model wording is omitted from the action card. Unsupported amounts, unsupported deadlines, and truncated quotations stay unverified.

### M2A-3 — Low — fixed for the capitalisation cases

A capitalised Bill or Energy is protected even when a billing word follows it. Lowercase phrases such as “the bill”, “billing”, “annual”, “problem”, and “energy billing” stay in place. Redaction and the payload guard use the same match.

### M2A-4 — Low

Google Fonts requests go to third-party domains. Prefer self-hosting during production hardening.

### M2A-5 — fixed for model category labels

The notice text selects the category. A model label of electricity does not apply Ofgem guidance to a council-tax notice. If the text supports more than one category, or the model names a category the text does not support, guidance stays general and confirmation is required.

### M2A-6 — Low

Some dates display without explicit evidence labels. Unverified deadline fallbacks need review.

### M2A-7 — Low

Sanitise displayed on-device error messages rather than rendering arbitrary `err.message`.

### M2A-8 — Low

The capability probe initially shows Limited Mode. A control is missing its `aria-describedby` target. A balance increase uses the reduction styling.

### Further notes from the same review

- `npm audit --omit=dev` reports four high findings through Firebase, Firestore, and `@grpc/grpc-js`. Assess the actual exposure before deployment. Dependency versions were not changed in this patch.
- The on-device timeout remains pending.
- Real Chrome request-body inspection is mandatory before a public demo.
- The original Milestone 0 `SpikeHarness` remains in the repository. It is not mounted by `App` and is not the production route.
- The Ofgem prompt uses the three canonical primary placeholders `[RECIPIENT_NAME]`, `[ACCOUNT_REF]`, and `[SUPPLY_ADDRESS]`. Review support for the other canonical bases and indexed placeholders during M2B.

## Milestone 2B-1 review

Review of `857d792` on `feat/m2b-secure-cloud-flow`. Live notice-to-cloud submission stays disabled. These notes do not claim that personal data is guaranteed to have been removed.

### M2B-1a — Soft-hyphen privacy regression — fixed for Z6

A known name such as Sarah Example stayed in the notice, and the final cloud guard accepted it, when U+00AD sat inside one component (`Sar` + U+00AD + `ah`). The shared fold treated that soft hyphen as a Unicode dash and turned it into `-`, so the component no longer matched. Detection, redaction, and the final payload guard now use one fold that removes U+00AD with the other format characters and keeps the original source offsets. Real hyphens in account references and surnames stay hyphens. This is not a claim that every personal identifier is removed.

### Z6d — Salutation detector can miss a soft-hyphen name — remaining limitation

`Dear Sar\u00ADah Exam\u00ADple` can miss the complete name in the salutation detector, so those components are not captured from the greeting and can escape. This remains a privacy limitation. It is a mandatory consideration before real cloud submission. The account-reference fix does not rewrite salutation detection.

### M2B-1b — Hard gate before cloud send or a product demonstration

Cancelled, withdrawn, negated, and historical-payment claims can still appear as Verified. Do not enable the M2B-2 cloud-send path, and do not record a product demonstration, until this is closed.

### M2B-1c — Approval can revive after an edit is reverted

A stored approval is still the same string comparison. Editing the payload and then restoring the same canonical bytes makes that approval match again. Cloud activation requires the approval to be invalidated immediately on any edit, and the approval must be usable only once.

### M2B-1d — Approval is not checked against the current canonical payload

`recordUserPayloadApproval` currently checks only that the string has the canonical prefix and contains no newlines. Before cloud activation it must be validated against the current canonical payload.

### M2B-1e — Ambiguous categories still need a decision

An ambiguous-category notice needs an explicit confirmation, or the product must stay on safe general guidance. A model label alone is not that confirmation.

A local privacy approval can record the exact canonical JSON. That record does not start a cloud send. It is not yet cleared by every edit: restoring the previous payload makes the stored string match again.

## Milestone 2

Milestone 2 live cloud submission of edited or redacted notices stays blocked. N-1, N-2, M2A-1, M2A-3, M2A-5, and M2B-1a are fixed for the cases named above. A local privacy approval records the exact canonical payload and does not start a cloud send. It is not yet invalidated by every edit. M2B-2 still has to connect a one-time approval to one cloud call after an independent security review. M2B-1b is a hard gate before that path is enabled or a product demonstration is recorded.

These stay assigned to M2B-2 and are not part of this correction:

- Role grounding and truncated quotations.
- Nonstandard placeholders.
- On-device inference timeout.
- Cloud response legal-language and invented-identifier validation.
- Real Chrome request-body inspection before a public demo.
- Content Security Policy and the dependency audit.
- Google Fonts third-party requests.
- SpikeHarness removal or isolation before a public demo.

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
