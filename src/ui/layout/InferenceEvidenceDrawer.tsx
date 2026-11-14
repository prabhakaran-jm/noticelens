import type { InferenceEvidenceReceipt } from "../../domain/evidenceReceipt";
import { InferenceBadge } from "../InferenceBadge";

export function InferenceEvidenceDrawer(props: {
  open: boolean;
  receipts: readonly InferenceEvidenceReceipt[];
  onClose: () => void;
}) {
  if (!props.open) {
    return null;
  }
  return (
    <div className="drawer-backdrop" onClick={props.onClose} role="presentation">
      <aside
        className="evidence-drawer"
        role="dialog"
        aria-labelledby="evidence-drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="evidence-drawer-title">Inference evidence</h2>
        <p>
          A receipt appears only after a model call returns. Local quote and date checks are not
          Firebase inference, and this drawer does not invent a latency or a source.
        </p>
        {props.receipts.length === 0 ? (
          <p data-testid="evidence-empty">No model call has been recorded.</p>
        ) : (
          props.receipts.map((receipt, index) => (
            <article className="receipt-card" key={`${receipt.payloadFingerprint ?? "local"}-${index}`}>
              <InferenceBadge
                actualInferenceSource={
                  receipt.inferenceSource === "unreported" ? undefined : receipt.inferenceSource
                }
                contextLabel={`receipt-${index}`}
              />
              <dl className="receipt-kv">
                <dt>Mode</dt>
                <dd>{receipt.mode}</dd>
                <dt>Reported source</dt>
                <dd>{receipt.inferenceSource}</dd>
                <dt>Latency</dt>
                <dd>{receipt.latencyMs} ms</dd>
                <dt>Outcome</dt>
                <dd>{receipt.outcome}</dd>
                <dt>Model</dt>
                <dd>{receipt.modelName ?? "Not reported"}</dd>
              </dl>
            </article>
          ))
        )}
        <button type="button" className="btn secondary" onClick={props.onClose}>
          Close
        </button>
      </aside>
    </div>
  );
}
