import type { CloudBriefInspection } from "../../adapters/cloudBriefBuilder";
import {
  CLOUD_SUBMISSION_BLOCKED_REASON,
  type CloudApprovalSession,
} from "../../adapters/cloudApprovalSession";

export function PrepareReplyScreen(props: {
  inspection: CloudBriefInspection;
  session: CloudApprovalSession;
  privacyApproved?: boolean;
  onReviewPrivacy?: () => void;
}) {
  return (
    <section className="stack" data-testid="screen-reply">
      <header className="screen-header">
        <p className="screen-eyebrow">Screen 3</p>
        <h1 className="screen-title">Prepare a reply</h1>
        <p className="screen-lead">
          You can inspect the local brief. Cloud drafting is switched off, so there is no reply to
          copy and no request is made.
        </p>
      </header>
      <div className="banner block" role="status" data-testid="cloud-disabled">
        {props.session.blockedReason}
      </div>
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
          disabled
          aria-describedby="cloud-disabled"
        >
          Send to cloud drafting
        </button>
        <button type="button" className="btn secondary" disabled>
          Copy reply
        </button>
        <button type="button" className="btn secondary" disabled>
          Download .txt
        </button>
      </div>
      <p>{CLOUD_SUBMISSION_BLOCKED_REASON}</p>
    </section>
  );
}
