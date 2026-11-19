import { useState } from "react";
import {
  CLOUD_SUBMISSION_BLOCKED_REASON,
} from "../../adapters/cloudApprovalSession";
import type { PrivacyApprovalView } from "../../adapters/privacyApproval";
import { STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS } from "../../domain/closedCloudBrief";
import {
  closePrivacyReview,
  openPrivacyReview,
  type PrivacyReview,
} from "../../domain/approvalRegistry";

export interface PayloadConfirmation {
  readonly serialized: string;
  readonly generation: number;
  readonly identifierContext: string;
}

/**
 * True only when the tick was made for this exact serialized payload,
 * this document generation, and this identifier context.
 */
export function payloadConfirmationMatches(
  confirmation: PayloadConfirmation | null,
  serialized: string | null,
  generation: number,
  identifierContext: string
): boolean {
  return (
    confirmation !== null &&
    serialized !== null &&
    confirmation.serialized === serialized &&
    confirmation.generation === generation &&
    confirmation.identifierContext === identifierContext
  );
}

/**
 * Shows the exact canonical payload for a person to approve.
 * Approval is local. This modal does not call the cloud drafter or begin a send lock.
 * The review tick is bound to the bytes on screen. A later payload, generation,
 * or identifier context clears it, including when the previous bytes return.
 */
export function PrivacyApprovalModal(props: {
  open: boolean;
  view: PrivacyApprovalView;
  generation: number;
  identifierContext: string;
  actionLabels?: readonly string[];
  onApprove: (serialized: string, review: PrivacyReview) => void;
  onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState<PayloadConfirmation | null>(null);
  const serialized = props.view.serialized;
  const locallyConfirmed = payloadConfirmationMatches(
    confirmation,
    serialized,
    props.generation,
    props.identifierContext
  );
  if (confirmation !== null && !locallyConfirmed) {
    setConfirmation(null);
  }
  if (!props.open) {
    return null;
  }
  const registryApproved = props.view.matchesCurrentPayload;
  const checked = locallyConfirmed || registryApproved;
  const canRecord = locallyConfirmed && !registryApproved;

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
          This records the exact JSON below for local review. An edit invalidates this
          approval, including if the text is changed back. Cloud drafting stays off.
        </p>
        <p className="banner block" role="status">
          Cloud sending disabled. {CLOUD_SUBMISSION_BLOCKED_REASON}
        </p>
        <p role="note" data-testid="privacy-structural-warning">
          {STRUCTURAL_VALIDATION_DOES_NOT_ESTABLISH_PAYMENT_CORRECTNESS}
        </p>
        <p data-testid="privacy-omitted-field-note">
          A null field in the JSON was withheld or not found. It does not mean the notice stated
          that the fact was absent.
        </p>
        {props.actionLabels && props.actionLabels.length > 0 ? (
          <>
            <p>These are fixed labels, not quotations from the notice.</p>
            <ul data-testid="privacy-action-labels">
              {props.actionLabels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </>
        ) : null}
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
            checked={checked}
            onChange={(event) => {
              if (!event.target.checked || serialized === null) {
                setConfirmation(null);
                return;
              }
              setConfirmation({
                serialized,
                generation: props.generation,
                identifierContext: props.identifierContext,
              });
            }}
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
              if (
                !payloadConfirmationMatches(
                  confirmation,
                  serialized,
                  props.generation,
                  props.identifierContext
                ) ||
                serialized === null ||
                props.view.matchesCurrentPayload
              ) {
                return;
              }
              const review = openPrivacyReview();
              try {
                props.onApprove(serialized, review);
              } finally {
                closePrivacyReview(review);
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
