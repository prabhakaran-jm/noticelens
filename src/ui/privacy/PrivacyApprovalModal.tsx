import { useState } from "react";
import {
  CLOUD_SUBMISSION_BLOCKED_REASON,
} from "../../adapters/cloudApprovalSession";
import type { PrivacyApprovalView } from "../../adapters/privacyApproval";

/**
 * Shows the exact canonical payload for a person to approve.
 * Approval is local. This modal does not call the cloud drafter or begin a send lock.
 */
export function PrivacyApprovalModal(props: {
  open: boolean;
  view: PrivacyApprovalView;
  onApprove: (serialized: string) => void;
  onClose: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  if (!props.open) {
    return null;
  }
  const serialized = props.view.serialized;
  const canRecord = Boolean(serialized) && reviewed && !props.view.matchesCurrentPayload;

  return (
    <div className="privacy-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className="privacy-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-approval-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="privacy-approval-title">Approve the exact brief</h2>
        <p>
          This records the exact JSON below for local review. Cloud drafting stays off.
        </p>
        <p className="banner block" role="status">
          {CLOUD_SUBMISSION_BLOCKED_REASON}
        </p>
        <ul>
          {props.view.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <pre className="exact-json" data-testid="privacy-exact-json">
          {serialized ?? "No exact payload is available."}
        </pre>
        <label className="field">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          I have reviewed this exact payload
        </label>
        <div className="btn-row">
          <button type="button" className="btn secondary" onClick={props.onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn"
            data-testid="privacy-approve"
            disabled={!canRecord}
            onClick={() => {
              if (serialized) {
                props.onApprove(serialized);
              }
            }}
          >
            Approve this exact payload
          </button>
        </div>
        {props.view.matchesCurrentPayload ? (
          <p data-testid="privacy-approved">This exact payload is approved. Sending is still off.</p>
        ) : null}
      </div>
    </div>
  );
}
