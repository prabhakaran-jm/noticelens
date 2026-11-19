import type { ReadableInspectionRow } from "../../adapters/cloudBriefBuilder";
import {
  CLOUD_SUBMISSION_BLOCKED_REASON,
  type CloudApprovalSession,
} from "../../adapters/cloudApprovalSession";
import { STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS } from "../../domain/closedCloudBrief";
import type { CloudDraftOutput } from "../../domain/types";

export interface CloudDraftDemo {
  sendEnabled: boolean;
  status: "idle" | "sending" | "accepted" | "error";
  message: string | null;
  draft: CloudDraftOutput | null;
  inferenceLabel: string | null;
  onSend?: () => void;
}

export function PrepareReplyScreen(props: {
  inspection: {
    limitations: readonly string[];
    violations: readonly string[];
    readableRows: readonly ReadableInspectionRow[];
    exactSerialized: string | null;
    formattedInspectionJson: string | null;
  };
  session: CloudApprovalSession;
  privacyApproved?: boolean;
  onReviewPrivacy?: () => void;
  cloudDemo?: CloudDraftDemo;
}) {
  return (
    <section className="stack" data-testid="screen-reply">
      <header className="screen-header">
        <p className="screen-eyebrow">Screen 3</p>
        <h1 className="screen-title">Prepare a reply</h1>
        <p className="screen-lead">
          You can inspect the local brief. Cloud drafting is synthetic-fixture-only.
          {props.cloudDemo
            ? " One explicit send uses the approved brief for the two synthetic examples."
            : " Cloud drafting is switched off, so there is no reply to copy and no request is made."}
        </p>
      </header>
      <p data-testid="cloud-demo-scope">
        Cloud drafting in this demo is synthetic-fixture-only. It applies to the two synthetic
        example notices, and only after a separate review.
      </p>
      <div className="banner block" role="status" data-testid="cloud-disabled">
        {props.cloudDemo
          ? "Production cloud sending stays off. This session can send only the two synthetic examples."
          : `Cloud sending disabled. ${props.session.blockedReason}`}
      </div>
      <p data-testid="cloud-fixture-explanation">
        Cloud drafting is available only for the two synthetic examples. Local analysis stays on
        this device.
      </p>
      <p className="banner block" role="note" data-testid="structural-validation-warning">
        {STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS}
      </p>
      <p data-testid="omitted-field-note">
        An empty amount, date, or deadline in the brief was withheld or not found. It does not mean
        the notice stated that the fact was absent.
      </p>
      <ul>
        {props.inspection.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {props.inspection.violations.length > 0 ? (
        <div className="banner" role="alert">
          {props.inspection.violations.join(" ")}
        </div>
      ) : null}
      <div className="inspection-shell">
        <h2 className="section-subtitle">Readable inspection view</h2>
        <table className="inspection-table">
          <tbody>
            {props.inspection.readableRows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section>
        <h2 className="section-subtitle">Exact outbound JSON</h2>
        <p>This is the exact serialized brief. It is not formatted for reading.</p>
        <pre className="exact-json" data-testid="exact-json">{props.inspection.exactSerialized ?? "No exact payload is available."}</pre>
      </section>
      <details>
        <summary>Formatted view (not the outbound payload)</summary>
        <pre className="exact-json" data-testid="formatted-json">{props.inspection.formattedInspectionJson ?? "No formatted view is available."}</pre>
      </details>
      <div className="btn-row">
        <button type="button" className="btn secondary" onClick={props.onReviewPrivacy}>
          Review privacy approval
        </button>
        {props.privacyApproved ? (
          <p data-testid="privacy-current">The current exact payload has a local approval. Sending stays off.</p>
        ) : null}
        <button
          type="button"
          className="btn"
          data-testid="cloud-send-button"
          disabled={!props.cloudDemo?.sendEnabled}
          aria-describedby="cloud-disabled"
          onClick={props.cloudDemo?.sendEnabled ? props.cloudDemo.onSend : undefined}
        >
          Send to cloud drafting
        </button>
        <button type="button" className="btn secondary" data-testid="cloud-copy-button" disabled>
          Copy reply
        </button>
        <button type="button" className="btn secondary" data-testid="cloud-download-button" disabled>
          Download .txt
        </button>
      </div>
      {props.cloudDemo?.status === "sending" ? (
        <p role="status" data-testid="cloud-draft-status">
          Sending the approved brief.
        </p>
      ) : null}
      {props.cloudDemo?.status === "error" && props.cloudDemo.message ? (
        <p role="alert" data-testid="cloud-draft-error">
          {props.cloudDemo.message}
        </p>
      ) : null}
      {props.cloudDemo?.status === "accepted" && props.cloudDemo.draft ? (
        <section data-testid="cloud-draft-output">
          <p data-testid="cloud-inference-label">
            Cloud inference: {props.cloudDemo.inferenceLabel ?? "unreported"}. This draft is not a
            verification of the balance, and it is not a verified saving.
          </p>
          <p>{props.cloudDemo.draft.summaryPlainEnglish}</p>
          <ul>
            {props.cloudDemo.draft.options.map((option) => (
              <li key={option.title}>
                <strong>{option.title}</strong> {option.rationale} {option.applicableCondition}
              </li>
            ))}
          </ul>
          <pre>{props.cloudDemo.draft.replyTemplateWithPlaceholders}</pre>
        </section>
      ) : null}
      <p>{CLOUD_SUBMISSION_BLOCKED_REASON}</p>
    </section>
  );
}
