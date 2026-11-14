# NoticeLens follow-ups after Milestone 1

This note is not a product screen. Milestone 1 stays on the deterministic domain core and the security fixes already on `feat/m1-deterministic-domain-core`. N-1 and N-2 are fixed for the reproductions named below, and M2A-2 is fixed in the Milestone 2A follow-up. M2B-1a is fixed for the soft-hyphen reproduction Z6. M2B-2A fixes K3/K5, the tested Z6d salutation variants, the named obligation-role cases, and the local approval lifecycle. Live cloud submission stays closed. The other items remain outstanding.

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

### Z6d — Soft-hyphen salutation — fixed for the tested variants

`Dear Sar\u00ADah Exam\u00ADple` is now detected as the complete original identifier, including the format characters, and redacted locally. The same path covers U+200B and U+2060 inside the salutation. Original character offsets are kept. The final cloud guard rejects those disguised forms. This is not a claim that every Unicode name variant is removed.

### K3/K5 — Partial account-reference leakage — fixed for the tested patterns

A name component is no longer split out of a letter token that continues with a separator and digits. `Ref SMITH-4471` for recipient John Smith becomes `Ref [ACCOUNT_REF]`, not `Ref [RECIPIENT_NAME]-4471`. Labelled and unlabelled forms are covered, including a lowercase reference and a Unicode hyphen, and a slash-joined token. A final cloud clause that still contains `[RECIPIENT_NAME]-8472`, or the same digit tail beside any other canonical placeholder, is rejected. Edited clauses are revalidated. Month labels such as `Nov-2026` are not treated as account references. Surrounding prose and original source offsets stay in place. This is not a claim that every identifier is removed.

### Soft-hyphen alphanumeric false positives — remaining limitation

A format character that joins letters to three or more digits is still treated as an account token. That catches hidden references such as `EXAMPLE` + U+00AD + `8472`. It can also flag ordinary text that is not an account reference, for example a word, a soft hyphen, and a number. That false positive remains. It is not solved by a special case for one reference string.

### M2B-1b — Obligation role grounding — fixed for the named cases

A £1,280 demand that the quotation says has been cancelled, a payment request the quotation says has been withdrawn, and “You do not need to pay the balance or contact…” are not Verified and do not enter the cloud-bound brief as established payment instructions. A historical payment of £1,280 already received is not shown as an outstanding balance. A truncated quotation stays incomplete. A quotation that both asks for payment and cancels that demand fails closed as ambiguous. “May be withdrawn”, “if payment is not received”, and “if you do not pay” are not treated as those blocking roles, so a genuine payable balance and a conditional fee stay supported. Quotation existence alone is not semantic support.

### M2B-1c — Approval invalidated on edit — fixed for the local lifecycle

Any relevant edit increments an approval generation immediately. Restoring the previous text does not restore the previous approval. Approval is recorded only from the deliberate review action. Each approval id is single-use: the future send function consumes it and still refuses to call the cloud. A stale callback recorded under an older generation does not match the current generation. The production screen does not call `CloudPayloadApproval.begin`.

### M2B-1d — Approval checked against the current canonical payload — fixed for the local record

`recordUserPayloadApproval` now requires the exact current canonical serialization and runs `canonicalCloudPayload` on it. Unknown keys, malformed placeholders, and clauses that fail the payload guard are rejected. This record still cannot send.

### M2B-1e — Ambiguous categories still need a decision

An ambiguous-category notice needs an explicit confirmation, or the product must stay on safe general guidance. A model label alone is not that confirmation.

A local privacy approval records the exact canonical JSON for the current edit generation. An edit invalidates it, including when the text is changed back. That record does not start a cloud send. `CLOUD_SUBMISSION_ENABLED` stays false.

## Milestone 2

Milestone 2 live cloud submission of edited or redacted notices stays blocked. N-1, N-2, M2A-1, M2A-3, M2A-5, M2B-1a, K3/K5, the tested Z6d variants, and the named M2B-1b obligation cases are fixed for the cases named above. A local privacy approval records the exact canonical payload, is invalidated by a later edit, and does not start a cloud send. M2B-2 still has to connect a one-time approval to one cloud call after an independent security review. Do not enable that path, and do not record a product demonstration, until the remaining items below are closed.

These stay tracked and are not implemented in M2B-2A:

- N-5 nonstandard placeholders, and export restrictions while a placeholder is unresolved or malformed.
- On-device inference timeout.
- Category confirmation for ambiguous notices (M2B-1e).
- Cloud-output legal-language and invented-identifier checks.
- Real Chrome request-body inspection before a public demo.
- Google Fonts third-party requests.
- Content Security Policy and the dependency audit.
- Demo-mode removal of the legacy SpikeHarness.
- Soft-hyphen alphanumeric false positives, where a format character joins letters to digits that are not an account reference.
- The benchmark still uses the old short-quote verifier. Role grounding above covers the named obligation cases only.

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
- Source role grounding beyond the cancelled, withdrawn, negated, historical, and truncated cases named under M2B-1b.
- Cloud output legal-conclusion validation.
- False positives in grouped number detection.
- Bracketed instructional text versus supported placeholder tokens.
- Real Chrome request-body audit.
- Content Security Policy, and removal of the legacy SpikeHarness before a demo.

Inference mode, the cloud model `gemini-3.5-flash-lite`, App Check, and the canonical immutable cloud snapshot stay as they are.
