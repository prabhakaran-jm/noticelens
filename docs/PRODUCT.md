# NoticeLens — Product brief

## User problem

A UK household receives a dense housing, council or utility notice. The recipient needs to know **what the notice requires, by when, why**, and how to respond. Users may not want to upload names, addresses and account numbers to cloud AI.

## Primary MVP scenario

A **synthetic** energy bill dated 18 November 2026 requests **£1,280** for electricity between January and June 2025 and asks the recipient to respond by **25 November 2026**. The user says they supplied meter readings and may not have received accurate earlier billing. NoticeLens extracts source-grounded actions, presents relevant conditions from curated Ofgem guidance, and prepares an editable letter. A second **synthetic** bill shows **£520**, and NoticeLens highlights changed facts and obligations. A lower amount is a demo fixture, not evidence that NoticeLens successfully contested a real bill.

## MVP acceptance criteria

- [ ] AI extraction runs via Firebase AI Logic with `ONLY_ON_DEVICE` on a compatible, ready device.
- [ ] A response accurately reports `inferenceSource: ON_DEVICE`.
- [ ] Action cards include document-verified quoted passages.
- [ ] Unmatched quotes are identified as unverified, never fabricated or silently accepted.
- [ ] Deadline and amount fields have test coverage using synthetic fixtures.
- [ ] The user sees the exact redacted *structural* payload before a cloud call.
- [ ] The cloud request uses Firebase AI Logic and `ONLY_IN_CLOUD`; `IN_CLOUD` is displayed only if actually reported.
- [ ] The cloud receives no raw original document or local entity map during the protected workflow.
- [ ] The user can edit and approve a drafted reply.
- [ ] The follow-up comparison shows £1,280 → £520 and links both values to source text.
- [ ] Unsupported Chrome environment displays a truthful Limited mode, and requires explicit consent before cloud processing.
- [ ] The full hackathon submission is testable without real customer personal data.

## Out of scope

- Automated legal determinations or guaranteed rights checks
- Automatic sending of email or letters
- Medical/clinical document handling
- Native Android implementation unless Web MVP and device feasibility are both proven
- Claims of guaranteed PII detection
