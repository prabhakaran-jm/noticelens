import { useState } from "react";
import { actionSummaryLabel } from "../../adapters/cloudBriefBuilder";
import {
  claimSupportLabel,
  type GroundedNoticeViewModel,
} from "../../adapters/groundNoticeFacts";
import type { LocalIdentifierEntry } from "../../domain/types";
import {
  ALLOWED_CIRCUMSTANCE_FLAGS,
  ALLOWED_RESPONSE_GOALS,
  type CircumstanceFlag,
  type ResponseGoal,
} from "../../domain/types";
import { formatGbp } from "../format";
import { SourceNoticeReader, type NoticeMark } from "../shared/SourceNoticeReader";

const GOAL_LABELS: Record<ResponseGoal, string> = {
  request_billing_review: "Ask for a billing review",
  request_breakdown_and_hold: "Ask for a breakdown and a hold",
  confirm_payment_plan_options: "Ask about payment plan options",
};

const FLAG_LABELS: Record<CircumstanceFlag, string> = {
  usage_billed_over_12_months: "The usage period may be longer than 12 months",
  previously_provided_meter_readings: "Meter readings were provided before",
  request_calculation_breakdown: "Ask how the amount was calculated",
  request_account_hold_during_review: "Ask for a hold while it is reviewed",
  request_breakdown: "Ask for a breakdown",
  clarify_dates: "Ask the sender to confirm the dates",
  query_missing_documents: "Ask about documents that were not included",
};

function marksFor(
  text: string,
  view: GroundedNoticeViewModel,
  identifiers: readonly LocalIdentifierEntry[]
): NoticeMark[] {
  const marks: NoticeMark[] = [];
  for (const obligation of view.obligations) {
    const verification = obligation.verification;
    if (
      verification?.startOffset !== null &&
      verification?.startOffset !== undefined &&
      verification.endOffset !== null &&
      verification.endOffset !== undefined
    ) {
      marks.push({
        start: verification.startOffset,
        end: verification.endOffset,
        kind: "quote",
        label: claimSupportLabel(obligation.headingSupport),
      });
    }
  }
  for (const entry of identifiers) {
    marks.push({
      start: entry.startOffset,
      end: entry.endOffset,
      kind: "identifier",
      label: "Flagged locally (check manually)",
    });
  }
  return marks.filter((mark) => mark.end <= text.length);
}

export function ActionPlanScreen(props: {
  view: GroundedNoticeViewModel;
  identifiers: readonly LocalIdentifierEntry[];
  responseGoal: ResponseGoal;
  onResponseGoal: (goal: ResponseGoal) => void;
  flags: readonly CircumstanceFlag[];
  onFlags: (flags: CircumstanceFlag[]) => void;
}) {
  const [pane, setPane] = useState<"facts" | "notice">("facts");
  const amount = props.view.amount.verifiedForDisplay;
  const period = props.view.billingPeriod.verifiedForDisplay;
  const deadlines = props.view.responseDeadlines.assessment;

  return (
    <section data-testid="screen-plan">
      <header className="screen-header">
        <p className="screen-eyebrow">Screen 2</p>
        <h1 className="screen-title">Action plan</h1>
        <p className="screen-lead">
          A figure is shown as verified only when the quoted passage supports it. An unsupported
          amount stays “Not stated”. Each action heading is the summary those words support.
          Finding the quotation in the notice does not verify any extra wording.
        </p>
      </header>
      <div className="mobile-pane-switcher" aria-label="Choose a pane">
        <button type="button" className="btn secondary" onClick={() => setPane("facts")}>
          Facts
        </button>
        <button type="button" className="btn secondary" onClick={() => setPane("notice")}>
          Notice
        </button>
      </div>
      <div className="split-workspace">
        <div className={pane === "notice" ? "pane-hidden-mobile stack" : "stack"}>
          {props.view.issueDate.assessment.futureDatedFixture && props.view.issueDate.assessment.label ? (
            <p className="banner info" data-testid="plan-future-date">
              {props.view.issueDate.assessment.label}
            </p>
          ) : null}
          {deadlines.conflictBanner ? (
            <p className="banner" role="status">
              {deadlines.conflictBanner}
            </p>
          ) : null}
          <div className="facts-grid">
            <article className="fact-tile">
              <span className="fact-label">Balance</span>
              <strong
                className={`fact-value${amount === null ? " is-missing" : ""}`}
                data-testid="plan-amount"
              >
                {amount === null ? "Not stated" : formatGbp(amount)}
              </strong>
              {props.view.amount.conflict ? (
                <span className="fact-pill fact-pill-warning">
                  Several amounts are stated: {props.view.amount.amountsGBP.map((value) => formatGbp(value)).join(", ")}
                </span>
              ) : null}
              {props.view.amount.conditionalFeesGBP.length > 0 ? (
                <p className="fact-subnote">
                  Conditional fee, not the balance:{" "}
                  {props.view.amount.conditionalFeesGBP.map((value) => formatGbp(value)).join(", ")}
                </p>
              ) : null}
            </article>
            <article className="fact-tile">
              <span className="fact-label">Billing period</span>
              <strong className={`fact-value${period ? "" : " is-missing"}`} data-testid="plan-period">
                {period ?? "Not stated"}
              </strong>
              {props.view.billingPeriod.gap.note ? (
                <span className="fact-pill fact-pill-warning">{props.view.billingPeriod.gap.note}</span>
              ) : null}
            </article>
            <article className="fact-tile">
              <span className="fact-label">Response date</span>
              <strong className="fact-value" data-testid="plan-deadline">
                {deadlines.dates.length === 0
                  ? "Not stated"
                  : deadlines.dates.map((item) => item.displayLabel).join(" ")}
              </strong>
            </article>
          </div>
          <section className="checklist-stack">
            <h2 className="section-subtitle">What the notice asks</h2>
            {props.view.obligations.length === 0 ? (
              <p>No quoted action was found in this notice.</p>
            ) : (
              props.view.obligations.map((item) => (
                <article
                  key={item.id}
                  className={`checklist-card${
                    item.headingSupport === "supports_claim" ? "" : " is-insufficient"
                  }`}
                  data-testid="plan-action-card"
                >
                  <h3 data-testid="plan-action-heading">{actionSummaryLabel(item.actionSummary)}</h3>
                  <blockquote className="quote-evidence-box">{item.sourceQuote}</blockquote>
                  <div className="checklist-meta-bar">
                    <span
                      className={
                        item.headingSupport === "supports_claim"
                          ? "verify-chip verify-chip-ok"
                          : "verify-chip verify-chip-warn"
                      }
                      data-testid="plan-action-support"
                    >
                      {claimSupportLabel(item.headingSupport)}
                    </span>
                  </div>
                </article>
              ))
            )}
          </section>
          <label className="field">
            What you want the reply to ask
            <select
              value={props.responseGoal}
              onChange={(event) => props.onResponseGoal(event.target.value as ResponseGoal)}
            >
              {ALLOWED_RESPONSE_GOALS.map((goal) => (
                <option key={goal} value={goal}>
                  {GOAL_LABELS[goal]}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="checks">
            <legend>Circumstances to include later</legend>
            {ALLOWED_CIRCUMSTANCE_FLAGS.map((flag) => (
              <label key={flag}>
                <input
                  type="checkbox"
                  checked={props.flags.includes(flag)}
                  onChange={(event) => {
                    props.onFlags(
                      event.target.checked
                        ? [...props.flags, flag]
                        : props.flags.filter((item) => item !== flag)
                    );
                  }}
                />
                {FLAG_LABELS[flag]}
              </label>
            ))}
          </fieldset>
        </div>
        <div className={pane === "facts" ? "pane-hidden-mobile" : undefined}>
          <SourceNoticeReader
            title="Original notice"
            text={props.view.rawText}
            marks={marksFor(props.view.rawText, props.view, props.identifiers)}
            testId="plan-reader"
          />
        </div>
      </div>
    </section>
  );
}
