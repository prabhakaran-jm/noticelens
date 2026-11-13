# **NoticeLens — Final Implementation-Ready MVP UI Specification**

*(Read-only specification mode maintained. Zero repository files modified; zero code written.)*

---

## **A. Final Four-Screen UX Specification**

NoticeLens MVP consists of **four primary screens** inside a persistent application shell, supported by **inline capability states** and **three non-screen overlays/panels** (Source Document Reader pane, Privacy Approval Modal, and Inference Evidence Drawer).

### **Global Application Shell**

- **Header Bar:**     &#x20;
  - **Brand & Scope:** NoticeLens wordmark + scope tag (`UK Energy & Household Notice Reader — Prototype`).
  - **Four-Step Navigation Bar:** `1. Read Notice` · `2. Action Plan` · `3. Prepare Reply` · `4. Compare Update`. Steps unlock progressively as prerequisites exist (or `1 → 3` via Limited Mode manual brief).
  - **Runtime Capability Pill (Button):** Displays live Firebase AI Logic on-device readiness (`On-Device Ready`, `Model Downloading`, `Limited Mode`) and opens the **Inference Evidence Drawer**.
- **Persistent Trust & Scope Footer:**     &#x20;
  - *"NoticeLens organises passages from your notice and summarises public guidance (currently curated for Ofgem domestic energy back-billing). It does not provide legal advice, determine whether a charge is valid, or select legally binding deadlines."*

---

### **Screen 1: Read Notice**

**Purpose:** Capture notice text locally, evaluate Chrome/Firebase on-device capability truthfully, and initiate local extraction—or guide the user honestly into Limited Mode when on-device Gemini Nano is unavailable.

- **Primary Layout:** Single focused card (`max-width: 760px` centered).
- **Honest Privacy Copy:**     &#x20;
  - *"During on-device analysis, your raw notice text is read locally by Chrome's built-in model and excluded from cloud AI requests. Standard Firebase app initialisation and security checks (such as App Check) still use network connections without transmitting your notice text."*
- **Notice Input Controls:**     &#x20;
  - **Paste Notice Textarea:** Primary text input (`min-height: 240px`) with character count and `[ Clear ]` action.
  - **Local `.txt` Import:** Client-side `FileReader` text load (labelled *"Loaded into browser memory"*).
  - **Primary Demo Fixture Loader:** Single prominent demo bar featuring energy-backbill-original.txt (`Load synthetic £1,280 electricity back-bill`). Non-energy QA fixtures (conflicting council tax dates, missing leasehold amount, two-tier PCN, rent proposal) stay out of headline consumer positioning—either reserved for automated test suites or tucked under a secondary `Developer / QA test fixtures` disclosure clearly badged `Extraction test only — no curated domain guidance`.
- **Inline Capability & Execution States (No Separate Screens):**     &#x20;
  - **Ready State:** Primary CTA `[ Analyse notice on this device ]` (`ONLY_ON_DEVICE`).
  - **Model Download / Warmup State:** Inline banner with live progress/status when Chrome reports on-device weights are downloading or warming up, offering `[ Wait for local model ]` or `[ Continue in Limited Mode ]`.
  - **Running State:** Inline progress indicator showing elapsed seconds and active local stages (*1. Running `ONLY_ON_DEVICE` extraction → 2. Verifying quotes against source text → 3. Tagging local personal identifiers*).
  - **Limited Mode State (Unsupported Browser / Hardware):** Calm amber/slate inline panel stating the detected unavailability reason. Blocks `PREFER_ON_DEVICE` fallback completely. Offers **Rule-Assisted Manual Brief Preparation** (user confirms notice type, dates, amounts, and manually reviews/masks regex-highlighted identifiers with an explicit warning that regex cannot guarantee complete PII removal) leading directly to the **Privacy Approval Modal** before Screen 3.

---

### **Screen 2: Action Plan**

**Purpose:** Present extracted facts, dynamic date status, neutral conflict/omission alerts, and a deterministically verified source-linked checklist alongside the raw notice.

- **Primary Layout:** Responsive two-pane workspace — **Supporting Source Reader Pane** (Left `45%` desktop; sticky tab/bottom sheet on mobile) + **Action Plan Column** (Right `55%`).
- **Header Provenance Strip:**     &#x20;
  - Displays provenance badge bound strictly to Firebase's `InferenceSource` enum (`InferenceSource.ON_DEVICE` → runtime value `'on_device'`), clickable to open the **Inference Evidence Drawer**.
- **Key Facts Summary Tiles:**     &#x20;
  - **Requested Amount(s):** Displays extracted monetary value(s) (e.g., `£1,280`) or `Not stated in notice` if absent (never defaulting missing amounts to `£0`).
  - **Billing / Reference Period:** Displays extracted period (`January and June 2025`). Computes duration relative to the **Document Issue Date** (`18 November 2026`), surfacing a neutral factual note (`Includes period >12 months prior to notice date`) rather than a legal conclusion. If the document issue date is in the future relative to the user's system clock, badges it clearly (`Synthetic / future notice date: DD MMM YYYY`).
  - **Response Deadline(s) & Dynamic Urgency:** Computes day delta dynamically against local calendar `today`:     &#x20;
    - `deadline < today`: **Expired / Past Date** badge — e.g., on `26 November 2026`, `25 November 2026` displays `Deadline date passed (1 day ago · 25 Nov 2026)` with calm guidance (*"Date on notice has passed — consider contacting the sender promptly"*).
    - `deadline === today`: **Due Today** badge (`Due today · 25 Nov 2026`).
    - `deadline > today`: **Upcoming** badge (`Due in N days · DD MMM YYYY`).
    - Unstated/vague text (`"promptly upon receipt"`): `No calendar date stated`.
  - **Conflicting Deadlines Rule (Strict Neutrality):** If multiple or inconsistent deadlines are extracted, **all dates are displayed at equal hierarchy**, each linked to its verbatim quote, accompanied by a neutral `Multiple dates stated in notice` banner advising the user to inspect each quoted clause or clarify with the sender. NoticeLens **never** labels one conflicting date as legally authoritative or overrides another.
- **Source-Grounded Action Checklist:**     &#x20;
  - Each extracted obligation card contains: user checkable box, plain-English summary, verbatim quotation block, and **Deterministic Quote Verification Status** (supporting inline state):     &#x20;
    - **Verified in notice:** Normalized exact substring match found in independent source text; `[ Highlight in notice ]` scrolls the Source Reader Pane to the exact character span.
    - **Unverified quote:** Displayed with an amber dashed border and `Unverified against notice text — read original letter` warning when substring verification fails; never silently hidden or matched to approximate text.
- **Bridge to Screen 3 — Structured Circumstance Intake (Zero Free-Text PII):**     &#x20;
  - User selects applicable factual checkboxes (for energy notices: *Usage billed >12 months after supply*, *Previously provided meter readings*, *Request calculation breakdown*, *Request account hold during review*; for non-energy notices: generic *Request breakdown / clarify dates / query missing documents* options).
  - CTA: `[ Review redacted brief for Cloud AI → ]` (opens **Privacy Approval Modal**).
  - Secondary CTA: `[ Compare a follow-up notice → ]` (navigates directly to Screen 4 without requiring any cloud call).

---

### **Supporting Overlay: Privacy Approval Modal (Gate Between Screen 2/Limited Mode & Screen 3)**

- **Native Modal Dialog (`<dialog>`):** Opens before any `ONLY_IN_CLOUD` call can fire.
- **Side-by-Side Inspection:**     &#x20;
  - **Excluded from Cloud AI Request (Kept in Browser Memory):** Raw notice text + detected local identifier map (`Sarah Example` → `[RECIPIENT_NAME]`, `EXAMPLE-8472` → `[ACCOUNT_REF]`, `14 Example Road, Reading, RG0 0AA` → `[SUPPLY_ADDRESS]`).
  - **Outbound Cloud AI Payload:** Toggleable between **Readable Summary** and **Exact Outbound JSON**. Contains only notice category, issue date, deadline(s), amount(s), billing period, user-checked circumstance flags, redacted verified clauses (editable/removable by user before approval), and the curated Ofgem public guidance excerpt (when domain = energy back-billing).
- **Accurate Consent Microcopy:** *"Approving sends only the structured payload shown on the right to Firebase AI Logic (`ONLY_IN_CLOUD`). Your full original notice and local identifier list are not included in this AI payload."*
- **Actions:** `[ Cancel — stay local ]` · `[ Approve & generate draft ]`.

---

### **Screen 3: Prepare Reply**

**Purpose:** Present conditional response options grounded in curated guidance (for energy back-billing) and an editable reply letter where personal details are restored locally on the device.

- **Header Provenance Strip:**     &#x20;
  - Binds strictly to `InferenceSource.IN_CLOUD` (runtime value `'in_cloud'`).
- **Section 1 — Conditional Response Options & Guidance Attribution:**     &#x20;
  - Displays 2–3 structured response approaches generated by `ONLY_IN_CLOUD`.
  - **Domain Scoping:** For the primary energy demo, attaches an attributable **Ofgem Back-Billing Public Guidance Card** stating eligibility conditions neutrally (*"May apply where unbilled energy was used more than 12 months before the bill date and the consumer did not obstruct meter access or act unreasonably"*). For unsupported/general test fixtures, explicitly displays `General correspondence mode — no curated statutory guidance loaded for this notice type`.
- **Section 2 — Editable Reply & Local Personalisation Controls:**     &#x20;
  - **Placeholder ↔ Local Personalisation Toggle:** Segmented switch `[ Personalised on this device ]` vs. `[ Raw cloud output (placeholders) ]`. Allows users and judges to verify that the cloud response contained `[RECIPIENT_NAME]`, `[ACCOUNT_REF]`, and `[SUPPLY_ADDRESS]`, and that local values were merged purely in client state.
  - **Editable Letter Area:** Plain-text editor pre-populated with the locally hydrated draft, plus a clearly marked **Local-Only Details Prompt** (*"Add specific meter reading dates here on your device before copying"*).
  - **Human Review Gate & Export:** Mandatory checkbox (`"I have checked all dates, figures, and personal details in this draft"`) unlocks `[ Copy reply text ]` and `[ Download .txt ]` (never a "Send" icon).

---

### **Screen 4: Compare Update**

**Purpose:** Compare an earlier notice against a revised/follow-up notice locally, linking changed values to source text and explicitly surfacing omitted fields.

- **Follow-Up Input Panel (Collapsible once loaded):**     &#x20;
  - Paste follow-up notice text or click `[ Load synthetic £520 revised statement (dated 2 Dec 2026) ]` (energy-backbill-revised.txt).
  - Runs local `ONLY_ON_DEVICE` extraction + deterministic quote verification on the revised notice (or manual entry in Limited Mode).
- **Future-Dated Synthetic Fixture Handling (`2 December 2026`):**     &#x20;
  - Because target submission is `26 November 2026` and the synthetic revised statement is dated `2 December 2026` (due `16 December 2026`), the comparison header displays **Notice Issue Dates explicitly** (`Original dated 18 Nov 2026` → `Revised dated 2 Dec 2026`) with a calm contextual pill when `revisedIssueDate > today`: `Synthetic follow-up dated 2 Dec 2026 (future-dated fixture)`. Deadline urgency for `16 December 2026` computes dynamically against `today` (`Upcoming · Due in N days · 16 Dec 2026`), while `25 November 2026` on the superseded notice is marked `Superseded original deadline (25 Nov 2026 · passed/upcoming relative to today)`.
- **Structured Fact Comparison Table (Including Omitted Fields):**     &#x20;
  - **Requested Amount:** `£1,280` → `£520` (`-£760` difference; both linked to verified source spans).
  - **Response Deadline:** `25 November 2026` → `16 December 2026` (`+21 calendar days later`; both linked to verified source spans).
  - **Billing Period (Omitted Field Detection):** `January and June 2025` → **`Not stated in revised notice`** (Amber `Omitted in update` badge with prompt: *"The revised statement does not state which supply dates the £520 covers — consider asking the supplier to confirm in writing"*).
  - **Stated Action / Tone:** `Pay balance or contact billing team` → `Contact billing team if you have questions`.
- **Side-by-Side Source Evidence Reader:**     &#x20;
  - Dual Original vs. Revised document cards; selecting any comparison row highlights the verified quote in both documents simultaneously (or highlights the original quote + `"Field not present"` indicator on the revised card when omitted).

---

### **Supporting Panel: Inference Evidence Drawer**

- Slide-over panel (accessible from any screen's header capability pill or provenance badge).
- Displays read-only runtime telemetry per Firebase AI Logic call in the session:     &#x20;
  - Call sequence number & timestamp
  - Requested mode (`ONLY_ON_DEVICE` vs `ONLY_IN_CLOUD`)
  - Matched `InferenceSource` enum status and exact SDK runtime string (`'on_device'` or `'in_cloud'`)
  - Elapsed inference duration (`ms`)
  - Whether raw notice text was included (`false` for all cloud calls) and expandable exact JSON sent for `ONLY_IN_CLOUD` calls
  - Quote verification count (`verified / total extracted quotes`).

---

## **B. React Component Hierarchy & Responsibilities**

### **Component Tree**

- `AppShell`     &#x20;
  - `TopNavHeader`     &#x20;
    - `StepProgressNav` (4 screens: Read Notice, Action Plan, Prepare Reply, Compare Update)
    - `RuntimeCapabilityPill` (triggers `InferenceEvidenceDrawer`)
  - `ScreenRouter` (client state router across the 4 screens)     &#x20;
    - **Screen 1 (`ReadNoticeScreen`)**     &#x20;
      - `CapabilityStatusBanner` (handles Ready, Model Downloading, Limited Mode, Extraction Error)
      - `NoticeInputForm` (textarea, local `.txt` loader, primary energy sample loader, collapsed QA fixture loader)
      - `LimitedModeBriefBuilder` (rendered inline only in Limited Mode: rule-assisted masking preview + manual fact fields)
    - **Screen 2 (`ActionPlanScreen`)**     &#x20;
      - `SplitDocumentWorkspace`     &#x20;
        - `SourceNoticeReader` (supporting pane: raw notice text, verified `<mark>` spans, local identifier underlines)
        - `ActionPlanPanel`     &#x20;
          - `InferenceProvenanceBadge` (maps `InferenceSource` enum)
          - `KeyFactsSummaryGrid` (`AmountTile`, `BillingPeriodTile`, `DynamicDeadlineTile`)
          - `DateConflictBanner` (conditional: neutral multi-date notice alert)
          - `GroundedChecklist` -> `ActionChecklistItem[]` (checkbox, summary, quote, verification badge, scroll-to-span trigger)
          - `StructuredCircumstanceSelector` (domain-scoped zero-PII checkboxes + CTA to open `PrivacyApprovalModal`)
    - **Screen 3 (`PrepareReplyScreen`)**     &#x20;
      - `InferenceProvenanceBadge`
      - `GuidanceAttributionBanner` (curated Ofgem card for energy demo; generic notice disclaimer otherwise)
      - `ResponseOptionsList` -> `ResponseOptionCard[]`
      - `ReplyEditorStudio`     &#x20;
        - `PersonalisationModeToggle` (`Personalised locally` vs `Raw cloud placeholders`)
        - `EditableReplyTextarea`
        - `HumanApprovalExportBar` (review confirmation checkbox + Copy / Download `.txt` buttons)
    - **Screen 4 (`CompareUpdateScreen`)**     &#x20;
      - `RevisedNoticeIntakeCollapsible` (paste input + synthetic £520 fixture loader)
      - `ComparisonDeltaTable` (rows for Amount, Deadline, Billing Period including omitted-field state, Required Action)
      - `DualSourceNoticeReader` (paired `SourceNoticeReader` instances for Original & Revised notices)
  - **Global Supporting Overlays**     &#x20;
    - `PrivacyApprovalModal` (native `<dialog>` wrapper inspecting local vault vs outbound JSON before `ONLY_IN_CLOUD`)
    - `InferenceEvidenceDrawer` (append-only session log of Firebase AI Logic calls and runtime `inferenceSource` receipts)
  - `LegalScopeFooter`

### **Core Component Responsibilities**

| Component                  | Single Responsibility & Boundary                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CapabilityStatusBanner`   | Queries Firebase AI Logic / Chrome on-device model readiness; renders truthful Ready, Downloading, or Limited Mode states without ever enabling `PREFER_ON_DEVICE`.                                                   |
| `SourceNoticeReader`       | Renders immutable original notice text, calculates highlight ranges from deterministic character offsets, and scrolls smoothly to active spans on desktop or mobile bottom-sheet.                                     |
| `DynamicDeadlineTile`      | Parses extracted ISO/UK dates against local calendar `today` at render time; distinguishes `Expired`, `Due Today`, `Upcoming`, `Future-Dated Fixture`, and `Unstated`; lists all dates neutrally when multiple exist. |
| `GroundedChecklist`        | Displays extracted obligations alongside deterministic substring verification status (`verified` with character span vs `unverified` warning).                                                                        |
| `PrivacyApprovalModal`     | Blocks `ONLY_IN_CLOUD` execution until explicit user confirmation; displays excluded local entity tokens alongside inspectable/editable outbound structured payload.                                                  |
| `ReplyEditorStudio`        | Keeps cloud placeholder output immutable while merging local PII map purely in browser memory; gates Copy/Download behind explicit user review confirmation.                                                          |
| `ComparisonDeltaTable`     | Computes deterministic field-by-field diffs between two extracted notice structures, explicitly flagging fields present in Notice A but omitted in Notice B.                                                          |
| `InferenceProvenanceBadge` | Compares SDK response against Firebase's `InferenceSource` enum (`InferenceSource.ON_DEVICE` / `'on_device'`, `InferenceSource.IN_CLOUD` / `'in_cloud'`) and opens `InferenceEvidenceDrawer`.                         |

---

## **C. UI State-Transition Table**

| Current Screen / Panel | State ID                | Entry Trigger                                                         | Visible UI Behaviour                                                                                                                                                                                             | Allowed Next Transitions                                                                 |
| ---------------------- | ----------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **1. Read Notice**     | `S1_PROBING`            | App initial mount                                                     | Input enabled; capability pill shows `Checking browser AI…`; submit button awaits probe completion.                                                                                                              | `S1_READY`, `S1_DOWNLOADING`, `S1_LIMITED`                                               |
| **1. Read Notice**     | `S1_READY`              | On-device model confirmed ready                                       | Emerald capability pill (`On-Device Ready`); primary button `[ Analyse notice on this device ]` active once input ≥ 20 chars.                                                                                    | `S1_EXTRACTING`                                                                          |
| **1. Read Notice**     | `S1_DOWNLOADING`        | Browser reports model downloadable / downloading                      | Inline progress banner explaining Chrome is downloading local model weights; offers wait or immediate Limited Mode switch.                                                                                       | `S1_READY`, `S1_LIMITED`                                                                 |
| **1. Read Notice**     | `S1_LIMITED`            | Browser/device unsupported or user opts in during download            | Honest `Limited Mode` banner with reason; hides local AI button; reveals `LimitedModeBriefBuilder` (rule-assisted masking + manual fields).                                                                      | `MODAL_PRIVACY_REVIEW` (for Cloud Reply), `S4_COMPARE_EMPTY` (manual diff)               |
| **1. Read Notice**     | `S1_EXTRACTING`         | User triggers local analysis                                          | Disables input; shows staged local progress (`ONLY_ON_DEVICE` → Deterministic Quote Verifier → Local Identifier Tagging).                                                                                        | `S2_PLAN_VIEW` (on valid structured output), `S1_EXTRACT_ERROR` (on timeout/parse error) |
| **1. Read Notice**     | `S1_EXTRACT_ERROR`      | `ONLY_ON_DEVICE` throws or returns unparseable JSON                   | Inline error alert (`Local extraction failed — raw notice was not sent anywhere`); actions to retry local run or use Limited Mode manual entry.                                                                  | `S1_EXTRACTING`, `S1_LIMITED`                                                            |
| **2. Action Plan**     | `S2_PLAN_VIEW`          | Local extraction + quote verifier complete                            | Displays `SourceNoticeReader` + `ActionPlanPanel` with `InferenceSource.ON_DEVICE` (`on_device`) badge, dynamic deadline status, neutral conflict banner (if >1 deadline), and verified/unverified quote badges. | `MODAL_PRIVACY_REVIEW`, `S4_COMPARE_EMPTY`, `S1_READY` (edit/new notice)                 |
| **Privacy Modal**      | `MODAL_PRIVACY_REVIEW`  | User clicks `[ Review redacted brief ]` from Screen 2 or Limited Mode | Opens modal `<dialog>` showing excluded raw notice/PII map vs outbound structured JSON + guidance ID.                                                                                                            | `S3_CLOUD_GENERATING` (Approve), returns to caller state (Cancel / `Esc`)                |
| **3. Prepare Reply**   | `S3_CLOUD_GENERATING`   | User approves payload in `PrivacyApprovalModal`                       | Closes modal; navigates to Screen 3; shows skeleton cards while `ONLY_IN_CLOUD` runs on approved brief.                                                                                                          | `S3_REPLY_READY`, `S3_CLOUD_ERROR`                                                       |
| **3. Prepare Reply**   | `S3_CLOUD_ERROR`        | `ONLY_IN_CLOUD` fails (e.g., offline / App Check / quota)             | Preserves approved brief locally; displays error state (`Cloud request failed — your local action plan is still intact`) with `[ Retry approved payload ]`.                                                      | `S3_CLOUD_GENERATING`, `S2_PLAN_VIEW`                                                    |
| **3. Prepare Reply**   | `S3_REPLY_READY`        | `ONLY_IN_CLOUD` succeeds                                              | Displays `InferenceSource.IN_CLOUD` (`in_cloud`) badge, conditional options, local personalisation toggle (`Personalised` ↔ `Placeholders`), and review-gated Copy/Download buttons.                             | `S4_COMPARE_EMPTY`, `S2_PLAN_VIEW`                                                       |
| **4. Compare Update**  | `S4_COMPARE_EMPTY`      | User navigates to `4. Compare Update`                                 | Shows summary of Original Notice + intake card for Revised Notice (paste or load £520 synthetic statement).                                                                                                      | `S4_EXTRACTING_REVISED`                                                                  |
| **4. Compare Update**  | `S4_EXTRACTING_REVISED` | User submits revised notice                                           | Runs local `ONLY_ON_DEVICE` + quote verification on second notice (or manual fields in Limited Mode).                                                                                                            | `S4_DIFF_READY`, `S4_COMPARE_ERROR`                                                      |
| **4. Compare Update**  | `S4_DIFF_READY`         | Second notice verified                                                | Renders `ComparisonDeltaTable` (`£1,280 → £520`, deadline shift, future-date fixture badge if notice date > `today`, and omitted billing period alert) + `DualSourceNoticeReader`.                               | `S2_PLAN_VIEW`, `S3_REPLY_READY`                                                         |

---

## **D. Responsive Design Tokens ("Civic Calm")**

All contrast values below represent **design targets to be verified during implementation testing** against WCAG 2.2 Level AA (`>= 4.5:1` normal text, `>= 3:1` UI components).

### **1. Colour Tokens**

| Token Name                           | Target Value          | Semantic Purpose                                                                                     |
| ------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `color.bg.canvas`                    | `#F6F5F1`             | Warm stone application backdrop                                                                      |
| `color.bg.surface`                   | `#FFFFFF`             | Cards, modal dialog, reply editor, comparison table                                                  |
| `color.bg.paper`                     | `#FCFBF8`             | Source notice document surface                                                                       |
| `color.border.subtle`                | `#E5E2D9`             | Card and document borders (`#9CA3AF` for interactive input borders to target `>= 3:1`)               |
| `color.text.primary`                 | `#111827`             | Primary body copy, amounts, headings                                                                 |
| `color.text.secondary`               | `#4B5563`             | Supporting labels, timestamps, footer disclaimers                                                    |
| `color.brand.navy`                   | `#1E3A5F`             | Primary CTAs, active step indicator, focus outlines                                                  |
| `color.provenance.onDeviceBg` / `Fg` | `#ECFDF5` / `#065F46` | `InferenceSource.ON_DEVICE` (`on_device`) badge & stayed-on-device identifier pills                  |
| `color.provenance.inCloudBg` / `Fg`  | `#EFF6FF` / `#1E40AF` | `InferenceSource.IN_CLOUD` (`in_cloud`) badge & approved cloud brief container                       |
| `color.quote.verifiedBg` / `Border`  | `#FEF3C7` / `#D97706` | Verified quote highlight in `SourceNoticeReader` (solid bottom border)                               |
| `color.status.warningBg` / `Fg`      | `#FFFBEB` / `#92400E` | Unverified quote (dashed border), omitted field alert, conflicting dates banner, Limited Mode banner |
| `color.deadline.expiredBg` / `Fg`    | `#FEF2F2` / `#991B1B` | Expired / past deadline indicator (paired with clock/alert icon, never colour-only)                  |
| `color.diff.reducedBg` / `Fg`        | `#F0FDF4` / `#166534` | Balance reduction / extended deadline delta highlight                                                |

### **2. Typography Tokens**

| Token Name            | Font Family Stack                                   | Size / Line-Height / Weight                          | Usage                                                                            |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `font.sans`           | `Plus Jakarta Sans`, `Inter`, system-ui, sans-serif | Variable `400–700`                                   | All application chrome, headings, checklists, options                            |
| `font.serif`          | `Source Serif 4`, `Georgia`, serif                  | `1rem` (`16px`) / `1.65` / `400`                     | Raw notice text inside `SourceNoticeReader` and verbatim quote blocks            |
| `font.mono`           | `JetBrains Mono`, `ui-monospace`, monospace         | `0.875rem` (`14px`) / `1.5` / `500` (`tabular-nums`) | Monetary figures, dates, `[PLACEHOLDER]` tokens, `on_device`/`in_cloud` receipts |
| `type.heading.screen` | `font.sans`                                         | Clamp `1.375rem` → `1.75rem` / `1.25` / `700`        | Screen titles                                                                    |
| `type.metric.key`     | `font.sans` (`tabular-nums`)                        | `1.375rem` (`22px`) / `1.2` / `700`                  | Summary tiles (`£1,280`, `25 Nov 2026`)                                          |

### **3. Breakpoints, Layout & Spacing Tokens**

| Breakpoint / Token  | Value                                                          | Layout Behaviour                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bp.mobile`         | `< 768px`                                                      | Single-column stack (`16px` outer padding); sticky top `Letter / Plan` segmented switcher on Screen 2 & `Original / Revised` switcher on Screen 4; bottom-sheet quote peek drawer; `44x44px` minimum tap target goal. |
| `bp.tablet`         | `768px – 1023px`                                               | Single-column container (`max-width: 760px`, `24px` padding) with collapsible pinned `SourceNoticeReader` above checklist.                                                                                            |
| `bp.desktop`        | `>= 1024px`                                                    | Centered `1320px` max-width container (`32px` padding); 12-column grid (`5 cols` sticky `SourceNoticeReader` + `7 cols` active screen content).                                                                       |
| `motion.transition` | `180ms ease-out` (`0ms` when `prefers-reduced-motion: reduce`) | Subtle highlight pulse, drawer slide, and progressive View Transition cross-fade.                                                                                                                                     |

---

## **E. Component Acceptance Criteria**

1. **`InferenceProvenanceBadge` & `InferenceEvidenceDrawer`**
   - Evaluates provenance strictly against Firebase's `InferenceSource` enum (`InferenceSource.ON_DEVICE` and `InferenceSource.IN_CLOUD`) rather than uppercase string literals.
   - Displays exact runtime string (`on_device` or `in_cloud`), requested inference mode, and call duration inside the drawer.
   - Renders an explicit `Unknown / Unreported` fallback if the SDK response omits `inferenceSource`; contains zero mock or override flags.
2. **`CapabilityStatusBanner` & `LimitedModeBriefBuilder`**
   - Never configures any Firebase AI Logic model instance with `PREFER_ON_DEVICE` for raw notice processing.
   - When on-device inference is unavailable, surfaces `Limited Mode` inline on Screen 1 with the truthful capability status and requires user review of any rule-assisted masking before opening `PrivacyApprovalModal`.
3. **`DynamicDeadlineTile` & `DateConflictBanner`**
   - Calculates day differences dynamically against the user's local calendar date at render time (midnight-normalized).
   - Distinguishes **Expired** (`deadline < today`, e.g., `25 Nov 2026` viewed on `26 Nov 2026`), **Due Today** (`deadline === today`), **Upcoming** (`deadline > today`), and **Unstated** (`null`).
   - Distinguishes **Notice Issue Date** from `today`: computes `>12 month` back-billing elapsed intervals relative to the notice's stated issue date (`18 Nov 2026`), and labels future-dated fixtures (`2 Dec 2026` viewed in November 2026) honestly as future-dated rather than rendering negative elapsed days.
   - When multiple deadlines appear in one notice, renders all extracted dates at equal visual weight linked to their verbatim quotes with a neutral `Multiple dates stated` alert—never declaring one deadline legally binding or authoritative.
4. **`GroundedChecklist` & `SourceNoticeReader`**
   - Runs deterministic whitespace-normalized substring matching against the raw input string (never against a model-rewritten transcript).
   - Matched quotes store exact `[startIndex, endIndex]` offsets and highlight/scroll the `SourceNoticeReader` on click/keyboard activation.
   - Unmatched quotes remain visible with a non-colour-only warning indicator (`⚠️ Unverified against notice text` + dashed border).
5. **`PrivacyApprovalModal`**
   - Blocks all `ONLY_IN_CLOUD` calls until explicit confirmation inside a native `<dialog>`.
   - Accurately describes data boundaries: confirms raw notice text and the local PII map are excluded from the outbound AI payload without making false absolute claims of zero browser network activity.
   - Allows inspecting the exact JSON object passed to the cloud prompt.
6. **`ReplyEditorStudio`**
   - Preserves raw cloud response with placeholders (`[RECIPIENT_NAME]`, `[ACCOUNT_REF]`, `[SUPPLY_ADDRESS]`) and applies local identifier substitution purely in browser memory, verifiable via a two-way toggle.
   - Frames curated Ofgem guidance conditionally (*"may apply if…"*) for energy notices, shows a neutral non-curated disclaimer for other fixture types, and requires a review checkbox before enabling Copy/Download (no send/email icons).
7. **`ComparisonDeltaTable`**
   - Compares structured outputs of Original vs. Revised notices without requiring cloud inference.
   - Explicitly detects and badges **omitted fields** (e.g., billing period `January and June 2025` present in energy-backbill-original.txt → `Not stated in revised notice` in energy-backbill-revised.txt).
8. **Accessibility Testing Goals (Target Verification Criteria for QA)**
   - Target WCAG 2.2 AA colour contrast (`>= 4.5:1` text, `>= 3:1` UI boundaries), full keyboard reachability across all 4 screens, proper `<dialog>` focus trapping/restoration, non-colour visual differentiators on all badges/highlights, and `aria-live="polite"` announcements when jumping to notice quotes or changing inference states.

---

## **F. Shortened Three-Minute Demo Storyboard**

**Demo Context:** Anchored strictly on the two synthetic energy notices (energy-backbill-original.txt and energy-backbill-revised.txt). Recorded live in Chrome Desktop with zero fabricated metrics or hardcoded badges.

| Time          | Screen / Panel                                            | Live Action                                                                                                                                                                                                                                                                                                                     | Demonstrated Capability & Accurate Narration                                                                                                                                                                                                                                                                       |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0:00–0:25** | **Screen 1: Read Notice**                                 | Click `Load synthetic £1,280 electricity back-bill`. Point out `Sarah Example`, `EXAMPLE-8472`, `£1,280` (Jan–Jun 2025), and deadline `25 November 2026`. Click `[ Analyse notice on this device ]`.                                                                                                                            | **Capability:** Local notice intake & capability detection.<br>*"A UK household receives a £1,280 electricity reminder covering Jan–Jun 2025. NoticeLens runs initial extraction locally via Firebase AI Logic `ONLY_ON_DEVICE`, keeping the raw notice out of cloud AI requests."*                                |
| **0:25–1:05** | **Screen 2: Action Plan** + **Inference Evidence Drawer** | Show dynamic deadline badge (upcoming or just-passed depending on recording date relative to `25 Nov 2026`) and `>12 months before bill date` factual note. Click an action card to scroll & highlight the exact quote in `SourceNoticeReader`. Open **Inference Evidence Drawer** to show live `inferenceSource: "on_device"`. | **Capability:** Real `InferenceSource.ON_DEVICE` (`on_device`) extraction + deterministic quote verification + dynamic deadline math.<br>*"Firebase reports runtime source `on_device`. Deterministic code verifies every quote word-for-word against the original notice and tags personal identifiers locally."* |
| **1:05–1:45** | **Screen 2 → Privacy Approval Modal**                     | Tick structured energy checkboxes (*">12 months prior to notice date"*, *"Provided meter readings"*). Click `[ Review redacted brief ]`. In the modal, toggle **Exact Outbound JSON** showing raw notice & identifiers excluded, then click `[ Approve & generate draft ]`.                                                     | **Capability:** Zero-PII structured intake + inspectable cloud consent boundary.<br>*"Before `ONLY_IN_CLOUD` runs, the Privacy Modal shows the exact sanitized brief and Ofgem guidance reference being sent—excluding Sarah's raw letter, name, address, and account reference."*                                 |
| **1:45–2:20** | **Screen 3: Prepare Reply**                               | Point to runtime `in_cloud` provenance badge and conditional Ofgem back-billing guidance card. Toggle `[ Raw cloud placeholders ]` ↔ `[ Personalised on this device ]` to show `[ACCOUNT_REF]` swapping to `EXAMPLE-8472` locally. Tick review checkbox and click `[ Copy reply text ]`.                                        | **Capability:** `InferenceSource.IN_CLOUD` (`in_cloud`) conditional options + client-side personalisation + non-legal framing.<br>*"Cloud Gemini explains when Ofgem's 12-month rule may apply—without declaring legal validity—and returns placeholders that NoticeLens fills in locally on the device."*         |
| **2:20–2:50** | **Screen 4: Compare Update**                              | Click `4. Compare Update` → load synthetic £520 revised statement (dated `2 Dec 2026`, badged as a future-dated synthetic follow-up). Click `£1,280 → £520` to highlight both source lines, and point out the amber **`Omitted in update`** alert for the missing billing period.                                               | **Capability:** Source-linked multi-notice diff + omitted field detection + future-date fixture handling.<br>*"When a revised £520 statement arrives, local extraction links `£1,280 → £520` and `25 Nov → 16 Dec` to both texts—and catches that the revised bill omitted the supply dates."*                     |
| **2:50–3:00** | **Screen 1 (Limited Mode state)**                         | Briefly show an unsupported browser window displaying inline **Limited Mode** blocking silent cloud fallback, then return to the 4-screen app.                                                                                                                                                                                  | **Capability:** Honest graceful degradation.<br>*"Where Gemini Nano is unavailable, Limited Mode blocks silent fallback and requires explicit consent—purpose-built hybrid AI with Firebase AI Logic."*                                                                                                            |

---

## **G. Implementation Priority List for Cursor (Post-Milestone 0)**

Execute in strict vertical order once Milestone 0 confirms `ONLY_ON_DEVICE`, `ONLY_IN_CLOUD`, and `InferenceSource` enum wiring:

1. **P0.1 — Domain Types, Inference Wrapper & Audit Log Store:** Define compact TypeScript interfaces for extracted notice facts, local identifier maps, outbound sanitized briefs, and session audit log entries mapped strictly to Firebase's `InferenceSource` enum (`on_device` / `in_cloud`), enforcing `ONLY_ON_DEVICE` and `ONLY_IN_CLOUD` (never `PREFER_ON_DEVICE`).
2. **P0.2 — Deterministic Engines (Pure Functions + Unit Tests First):**     &#x20;
   - Whitespace-normalized substring quote verifier returning `{ verified: boolean, startOffset?: number, endOffset?: number }`.
   - Dynamic calendar utility computing expired/due-today/upcoming day deltas, `>12 month` gap relative to document issue date, future-dated fixture detection (`2 Dec 2026` vs `today`), and neutral multi-date conflict detection.
   - Local redaction sanitizer & placeholder hydrator (`[RECIPIENT_NAME]`, `[ACCOUNT_REF]`, `[SUPPLY_ADDRESS]`).
   - Notice comparison diff engine including explicit omitted-field detection (`present → null`).
3. **P0.3 — Screen 1 (`Read Notice`) & Inline Capability / Limited Mode States:** Build notice paste/load input, primary energy demo loader, live capability probe banner (Ready / Downloading / Limited Mode), and `LimitedModeBriefBuilder`.
4. **P0.4 — Screen 2 (`Action Plan`) & `SourceNoticeReader`:** Build split reader/checklist layout, dynamic deadline & neutral conflict UI, verified/unverified quote badges with click-to-highlight scrolling, and structured zero-PII circumstance checkboxes.
5. **P0.5 — `PrivacyApprovalModal` & Curated Ofgem Guidance Module:** Implement native `<dialog>` payload inspector (local vault vs exact outbound JSON), bundle the static attributable Ofgem back-billing summary excerpt, and wire explicit approval to `ONLY_IN_CLOUD`.
6. **P0.6 — Screen 3 (`Prepare Reply`) & Local Personalisation Toggle:** Render conditional options, domain-scope banner, placeholder ↔ locally personalised toggle, editable letter textarea, and human-review-gated Copy/Download `.txt`.
7. **P1.1 — Screen 4 (`Compare Update`):** Wire second-notice local extraction (`£520` fixture), `ComparisonDeltaTable` (highlighting `-£760`, deadline change, future-dated synthetic notice date, and omitted billing period), and `DualSourceNoticeReader`.
8. **P1.2 — `InferenceEvidenceDrawer` & Five Synthetic Automated Test Fixtures:** Expose the slide-over SDK receipt log from provenance badges and run automated tests across the energy pair plus the conflicting-dates, missing-amount, two-tier PCN, and tenancy fixtures.
9. **P2.1 — Responsive Mobile Drawer, Civic Calm Polish & Accessibility Audit:** Add mobile segmented switcher/quote bottom-sheet, keyboard/focus-trap testing on `<dialog>`, non-colour highlight styles, and WCAG 2.2 AA contrast verification.

---

## **Five Most Important UX Requirements Cursor Must Preserve**

1. **Strict `InferenceSource` Enum Truthfulness & Zero Silent Cloud Fallback:** Never use `PREFER_ON_DEVICE` on raw notices, never hardcode provenance badges, and always evaluate runtime provenance via Firebase's `InferenceSource` enum (`InferenceSource.ON_DEVICE` / `'on_device'` and `InferenceSource.IN_CLOUD` / `'in_cloud'`), routing unsupported browsers into an honest inline **Limited Mode**.
2. **Deterministic Quote Verification Over Independent Text:** Every extracted obligation on `Action Plan` and `Compare Update` must verify its quote character-for-character against the user's raw notice string—highlighting exact spans when verified and visibly flagging unmatched quotes as `Unverified` rather than silently hiding or approximating them.
3. **Hard Privacy Approval Airlock & Observable Local Personalisation:** Raw notice text and local personal identifiers must never enter `ONLY_IN_CLOUD` payloads; users must inspect and approve the exact structured brief in `PrivacyApprovalModal`, and `Prepare Reply` must let users toggle between raw cloud `[PLACEHOLDERS]` and locally restored details.
4. **Neutrality on Legal Validity & Conflicting Deadlines:** Never declare a bill invalid/unenforceable or pick an authoritative deadline when dates conflict—list all conflicting dates neutrally with their source quotes, frame curated Ofgem rules strictly as conditional public guidance for the energy domain, and distinguish expired, upcoming, and future-dated synthetic notice dates (`2 Dec 2026`) dynamically.
5. **Explicit Omitted-Field Detection in Notice Comparison:** `Compare Update` must not merely diff `£1,280 → £520` and `25 Nov 2026 → 16 Dec 2026`; it must explicitly flag when material context present in the original notice (such as the `January and June 2025` billing period) is omitted from the revised statement.