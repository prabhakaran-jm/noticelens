import type { DeadlineRole, NoticeComparison } from "../../domain/compareNotices";
import type { SourceAmountAuthority } from "../../domain/sourceGrounding";
import { formatGbp, formatSignedDifference } from "../format";
import { SourceNoticeReader } from "../shared/SourceNoticeReader";

function balanceLabel(value: number | null, authority: SourceAmountAuthority): string {
  if (authority === "verified" && value !== null) {
    return formatGbp(value);
  }
  if (authority === "not_stated") {
    return "Not stated";
  }
  return "Needs review";
}

function differenceLabel(comparison: NoticeComparison): string {
  if (comparison.relationship === "COMPARABLE") {
    return formatSignedDifference(comparison.amount.differenceGBP);
  }
  if (comparison.relationship === "NOT_COMPARABLE") {
    return "Different liabilities";
  }
  if (
    comparison.amount.originalAuthority === "not_stated" &&
    comparison.amount.revisedAuthority === "not_stated"
  ) {
    return "Not stated";
  }
  return "Needs review";
}

function dateLabel(stated: string | null, authority: SourceAmountAuthority, role: DeadlineRole | null = null): string {
  if (authority !== "verified" || !stated) {
    return authority === "not_stated" ? "Not stated" : "Needs review";
  }
  if (role === "contact") {
    return `Contact deadline: ${stated}`;
  }
  return stated;
}

function relationshipNote(comparison: NoticeComparison): string | null {
  if (comparison.relationship === "NOT_COMPARABLE") {
    return "These notices do not describe the same liability.";
  }
  if (comparison.relationship === "RELATIONSHIP_UNVERIFIED") {
    return "The relationship between these notices needs review. No verified change is shown.";
  }
  return null;
}

export function CompareUpdateScreen(props: {
  originalText: string;
  revisedText: string;
  onRevisedText: (text: string) => void;
  comparison: NoticeComparison;
}) {
  const revisedBanner = props.comparison.issueDate.revisedAssessment;
  const originalBanner = props.comparison.issueDate.originalAssessment;
  return (
    <section className="stack" data-testid="screen-compare">
      <header className="screen-header">
        <p className="screen-eyebrow">Screen 4</p>
        <h1 className="screen-title">Compare an update</h1>
        <p className="screen-lead">
          Both notices stay on this page. A field the revised notice drops is marked missing rather
          than copied forward.
        </p>
      </header>
      {originalBanner?.futureDatedFixture && originalBanner.label ? (
        <p className="banner info" data-testid="original-future-date">
          {originalBanner.label}
        </p>
      ) : null}
      {revisedBanner?.futureDatedFixture && revisedBanner.label ? (
        <p className="banner info" data-testid="future-date-banner">
          {revisedBanner.label}
        </p>
      ) : null}
      {relationshipNote(props.comparison) ? (
        <p className="banner" data-testid="compare-relationship" role="status">
          {relationshipNote(props.comparison)}
        </p>
      ) : (
        <p className="sr-only" data-testid="compare-relationship">
          {props.comparison.relationship}
        </p>
      )}
      {props.comparison.billingPeriod.omittedInRevised && props.comparison.billingPeriod.omissionPrompt ? (
        <p className="banner" data-testid="omission-alert" role="status">
          {props.comparison.billingPeriod.omissionPrompt}
        </p>
      ) : null}
      <table className="delta-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Original</th>
            <th>Revised</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Balance</th>
            <td data-label="Original" data-testid="compare-original-amount">
              {balanceLabel(props.comparison.amount.value, props.comparison.amount.originalAuthority)}
            </td>
            <td data-label="Revised" data-testid="compare-revised-amount">
              {balanceLabel(props.comparison.amount.revised, props.comparison.amount.revisedAuthority)}
            </td>
          </tr>
          <tr>
            <th scope="row">Difference</th>
            <td colSpan={2} data-label="Difference" data-testid="amount-difference">
              <span className="delta-badge-reduced">{differenceLabel(props.comparison)}</span>
            </td>
          </tr>
          <tr className={props.comparison.billingPeriod.omittedInRevised ? "delta-row is-omitted-row" : "delta-row"}>
            <th scope="row">Billing period</th>
            <td data-label="Original">{props.comparison.billingPeriod.verifiedForDisplay ?? "Not stated"}</td>
            <td data-label="Revised">
              {props.comparison.billingPeriod.omittedInRevised ? (
                <span className="delta-badge-omitted">
                  {props.comparison.billingPeriod.omissionNote ?? "Not stated"}
                </span>
              ) : (
                props.comparison.billingPeriod.revised ?? "Not stated"
              )}
            </td>
          </tr>
          <tr>
            <th scope="row">Notice date</th>
            <td data-label="Original" data-testid="compare-original-issue">
              {dateLabel(props.comparison.issueDate.original, props.comparison.issueDate.originalAuthority)}
            </td>
            <td data-label="Revised" data-testid="compare-revised-issue">
              {dateLabel(props.comparison.issueDate.revised, props.comparison.issueDate.revisedAuthority)}
            </td>
          </tr>
          <tr>
            <th scope="row">Response date</th>
            <td data-label="Original" data-testid="compare-original-response">
              {dateLabel(
                props.comparison.responseDeadline.value,
                props.comparison.responseDeadline.originalAuthority,
                props.comparison.responseDeadline.originalRole
              )}
            </td>
            <td data-label="Revised" data-testid="compare-revised-response">
              {dateLabel(
                props.comparison.responseDeadline.revised,
                props.comparison.responseDeadline.revisedAuthority,
                props.comparison.responseDeadline.revisedRole
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="dual-reader-grid">
        <SourceNoticeReader title="Original notice" text={props.originalText} marks={[]} />
        <SourceNoticeReader title="Revised notice" text={props.revisedText} marks={[]} />
      </div>
      <label className="field">
        Revised notice text
        <textarea
          data-testid="revised-text"
          value={props.revisedText}
          onChange={(event) => props.onRevisedText(event.target.value)}
          spellCheck={false}
        />
      </label>
    </section>
  );
}
