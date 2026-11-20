import type { WorkflowStep } from "./TopNavHeader";

const STAGES: { id: WorkflowStep; title: string; detail: string; blocked?: boolean }[] = [
  {
    id: "read",
    title: "1. On-device reading",
    detail: "Optional browser model. Raw notice text has no cloud fallback.",
  },
  {
    id: "plan",
    title: "2. Local checks",
    detail: "Quotes, amounts, and dates are checked in the browser.",
  },
  {
    id: "reply",
    title: "3. Review response brief",
    detail: "Inspect the exact local brief before any future cloud use.",
  },
  {
    id: "compare",
    title: "4. Compare update",
    detail: "A second notice is compared locally.",
  },
];

export function HybridStagesStrip(props: { step: WorkflowStep }) {
  return (
    <div className="hybrid-stages-strip" aria-label="Hybrid pipeline stages">
      {STAGES.map((stage) => (
        <article
          key={stage.id}
          className={`hybrid-stage-card${props.step === stage.id ? " is-current" : ""}${
            stage.blocked ? " is-blocked" : ""
          }`}
        >
          <h2 className="hybrid-stage-title">{stage.title}</h2>
          <p className="hybrid-stage-desc">{stage.detail}</p>
        </article>
      ))}
    </div>
  );
}
