# NoticeLens follow-ups after Milestone 1

This note is not a product screen. Milestone 1 stays on the deterministic domain core and the security fixes already on `feat/m1-deterministic-domain-core`. N-1 and N-2 are fixed for the reproductions named below, and M2A-2 is fixed in the Milestone 2A follow-up. M2B-1a is fixed for the soft-hyphen reproduction Z6. M2B-2A records a local approval lifecycle and the K3/K5 cases that were tested, and R5-1 is fixed for the short digit tails named below. M2B-2B records the R5-2, R5-3, R5-4, and R5-5 cases named below. Live cloud submission stays closed. These notes do not claim that personal data is guaranteed to have been removed.

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

### Z6d / R5-2 — Normalised name components — fixed for the tested cases

`Dear Sar\u00ADah Exam\u00ADple` is still detected as the complete original identifier. Name components are now taken from the normalised identifier, so a format character inside a known name no longer drops `Sarah` or `Example`. The same extraction covers U+200B, U+2060, NFC, NFD, and fullwidth forms of a known name. Plain occurrences elsewhere in the notice are redacted, and an edited clause that reintroduces a protected component is rejected. Original offsets stay in place. Lowercase `bill` and `energy billing` stay in place when the capitalised name is protected. This is not a claim that every personal identifier is removed. Two-letter names remain under N-3.

### K3/K5 — Partial account-reference leakage — fixed for the tested longer tokens

`Ref SMITH-4471` for recipient John Smith becomes `Ref [ACCOUNT_REF]`, not `Ref [RECIPIENT_NAME]-4471`. The tested labelled and unlabelled forms include a lowercase reference, a Unicode hyphen, and a slash-joined token with at least three digits. A final cloud clause that still contains `[RECIPIENT_NAME]-8472`, or the same digit tail beside any other canonical placeholder, is rejected for those tested shapes. Month labels such as `Nov-2026` are not treated as account references. Surrounding prose and original source offsets stay in place. This is not a claim that every identifier is removed.

### R5-1 — Short digit tails after a known name — fixed

`Ref SMITH-44`, `Smith/7`, `Sarah-1`, and `Example-12` were redacted on `b7384fb` and then escaped both redaction and the final guard. The name-component skip ran whenever digits followed a separator, even when no account span had been detected. A name component is now left in place only when that occurrence sits inside a detected account span. These four tokens are redacted to the recipient placeholder plus the unmatched tail, and canonical validation and edited-clause revalidation reject both the raw token and the partial placeholder. Complete account tokens such as `SMITH-4471` are still replaced as one `[ACCOUNT_REF]`.

### R5-4 — Joined references and placeholder tails — fixed for the tested shapes

`SMITH4471`, `SMITH_4471`, `SMITH.4471`, and the same letter-digit form with `:` or `#`, are detected as one account reference. A fullwidth dot is included. A canonical placeholder does not hide a numeric tail: `[RECIPIENT_NAME]_8472`, `[ACCOUNT_REF].8472`, `[ACCOUNT_REF_2]:8472`, and the same tail on the other canonical bases with `_`, `.`, `:`, `#`, `/`, or `-`, are rejected in an edited clause. `Nov-2026`, `Nov2026`, `balance2026`, and `billing2026` stay prose. A surname glued to a year, such as `SMITH-2026`, can still be treated as an account reference. That is an availability false positive, not a privacy leak. R5-6 remains open.

### Soft-hyphen alphanumeric false positives — remaining limitation

A format character that joins letters to three or more digits is still treated as an account token. That catches hidden references such as `EXAMPLE` + U+00AD + `8472`. It can also flag ordinary text that is not an account reference, for example a word, a soft hyphen, and a number. That false positive remains. It is not solved by a special case for one reference string.

### M2B-1b / R5-3 — Obligation role grounding — fixed for the tested sentences

A current demand is distinguished from a negated, withdrawn, cancelled, historical, settled, conditional, or quoted statement by the clause around it. “You must pay nothing.”, “Please ignore our request to pay.”, “You do not have to pay.”, “Thank you for your payment of £1,280.”, “This account is paid in full.”, “The balance of £1,280 has been written off.”, “Payment is no longer required.”, “The charge has been waived.”, and “The payment was refunded.” are not verified. A truncated quotation stays incomplete. A quoted or prompt-injected balance is not a current demand. “Please pay £1,280 or the revised £520.” stays ambiguous. A genuine outstanding balance of £1,280, a later outstanding balance of £520 beside a historical £1,280, and a conditional £40 fee beside a current £1,280 stay as they were: the current balance and deadline can be verified, and the conditional fee is not the main balance. The Action Plan, the amount tile, and the cloud brief use that same support. A separate genuine “please pay” sentence remains verified when another sentence says an earlier demand was cancelled. This is clause-role evidence, not general language understanding. An unseen wording can still be wrong. Do not treat that remaining gap as closed.

### M2B-1c — Approval invalidated on edit — fixed for the local lifecycle

Any relevant edit increments an approval generation immediately. Restoring the previous text does not restore the previous approval. Approval is recorded only from the deliberate review action. Each approval id is single-use: the future send function consumes it and still refuses to call the cloud. A stale callback recorded under an older generation does not match the current generation. The production screen does not call `CloudPayloadApproval.begin`.

### M2B-1d — Approval checked against the current canonical payload — local record only

`recordUserPayloadApproval` requires the exact current canonical serialization and runs `canonicalCloudPayload` on it. Unknown keys, malformed placeholders, and clauses that fail the payload guard are rejected. This record still cannot send.

### R5-5 — Approval uses the same guard options — fixed for the local record

Candidate construction, inspection, approval, and the pre-send check now share one `CloudPayloadGuardOptions` value built from the local identifier map and the user-added private identifiers. Approval runs canonical validation itself. It is bound to the exact current serialized payload. The still-disabled send revalidates that snapshot with the stored options and then refuses. A failed revalidation is a generic error, the approval id is consumed, and the error does not echo the identifier. Approval does not take the cloud-send lock. `CLOUD_SUBMISSION_ENABLED` stays false. The live cloud-send function is not connected.

### R5-6 — Standards-shaped tokens are an availability issue

Tokens such as `Form-1040`, `ISO-9001`, and `Section-123` can be treated as account references. That can block a legitimate brief. It is an availability problem, not a privacy leak.

### M2B-1e — Ambiguous categories still need a decision

An ambiguous-category notice needs an explicit confirmation, or the product must stay on safe general guidance. A model label alone is not that confirmation.

A local privacy approval records the exact canonical JSON for the current edit generation. An edit invalidates it, including when the text is changed back. That record does not start a cloud send. `CLOUD_SUBMISSION_ENABLED` stays false.

## Milestone 2

Milestone 2 live cloud submission of edited or redacted notices stays blocked. N-1, N-2, M2A-1, M2A-3, M2A-5, M2B-1a, the tested K3/K5 tokens, R5-1, R5-2, R5-3, R5-4, and R5-5 are fixed for the cases named above. A local privacy approval records the exact canonical payload, is invalidated by a later edit, stores the guard options, and does not start a cloud send. The pre-send check revalidates those options and still refuses. Do not enable cloud submission, and do not record a product demonstration, until an independent review closes the remaining items below.

These stay tracked and are not implemented here:

- N-5 nonstandard placeholders, and export restrictions while a placeholder is unresolved or malformed.
- On-device inference timeout.
- Category confirmation for ambiguous notices (M2B-1e).
- Cloud-output legal-language and invented-identifier checks.
- Real Chrome request-body inspection before a public demo.
- Google Fonts third-party requests.
- Content Security Policy and the dependency audit.
- Demo-mode removal of the legacy SpikeHarness.
- Soft-hyphen alphanumeric false positives, where a format character joins letters to digits that are not an account reference.
- R5-3 remaining gap: clause-role patterns do not understand every negation, quotation, or contradiction. An unseen wording can still be classified wrongly.
- R5-6: Form-1040, ISO-9001, and Section-123 can be treated as account references. A surname plus a year, such as SMITH-2026, can too. Those are availability issues, not privacy leaks.
- The benchmark still uses the old short-quote verifier.
- Live cloud drafting is not connected. `CLOUD_SUBMISSION_ENABLED` stays false until an independent review says otherwise.

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
- Source role grounding beyond the tested R5-3 sentences. Unseen negations, quotations, and contradictions can still be classified wrongly.
- Cloud output legal-conclusion validation.
- False positives in grouped number detection.
- Bracketed instructional text versus supported placeholder tokens.
- Real Chrome request-body audit.
- Content Security Policy, and removal of the legacy SpikeHarness before a demo.

Inference mode, the cloud model `gemini-3.5-flash-lite`, App Check, and the canonical immutable cloud snapshot stay as they are.
