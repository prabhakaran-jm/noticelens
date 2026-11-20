import type { ChromeCapabilityReport } from "../../ai/capability";

export type WorkflowStep = "read" | "plan" | "reply" | "compare";

const STEPS: { id: WorkflowStep; label: string }[] = [
  { id: "read", label: "Read notice" },
  { id: "plan", label: "Action plan" },
  { id: "reply", label: "Prepare reply" },
  { id: "compare", label: "Compare update" },
];

function capabilityClass(report: ChromeCapabilityReport | null): string {
  if (!report) {
    return "state-limited";
  }
  if (report.availability === "available") {
    return "state-ready";
  }
  if (report.availability === "downloadable" || report.availability === "downloading") {
    return "state-downloading";
  }
  if (report.availability === "probe_error") {
    return "state-error";
  }
  return "state-limited";
}

function capabilityLabel(report: ChromeCapabilityReport | null): string {
  if (!report) {
    return "Checking this browser";
  }
  switch (report.availability) {
    case "available":
      return "On-device model ready";
    case "downloadable":
      return "On-device model can download";
    case "downloading":
      return "On-device model downloading";
    case "unavailable":
      return "Limited Mode";
    case "api_missing":
      return "Limited Mode";
    case "probe_error":
      return "Model check failed";
  }
}

export function TopNavHeader(props: {
  step: WorkflowStep;
  onStep: (step: WorkflowStep) => void;
  capability: ChromeCapabilityReport | null;
  onOpenEvidence: () => void;
}) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <div>
            <p className="brand-title">NoticeLens</p>
            <p className="brand-subtitle">Understand the notice. Check the source.</p>
          </div>
        </div>
        <nav aria-label="Notice workflow steps">
          <ol className="step-nav">
            {STEPS.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="step-btn"
                  aria-current={props.step === item.id ? "step" : undefined}
                  data-testid={`nav-${item.id}`}
                  onClick={() => props.onStep(item.id)}
                >
                  <span className="step-num">{index + 1}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <button
          type="button"
          className={`capability-pill ${capabilityClass(props.capability)}`}
          onClick={props.onOpenEvidence}
          data-testid="capability-pill"
        >
          <span className="status-dot" aria-hidden="true" />
          {capabilityLabel(props.capability)}
        </button>
      </div>
    </header>
  );
}
