import { useState } from "react";
import type { ChromeCapabilityReport } from "../../ai/capability";
import {
  claimSupportLabel,
  type GroundedNoticeViewModel,
} from "../../adapters/groundNoticeFacts";
import { formatGbp } from "../format";

function amountSupportLabel(
  support: Parameters<typeof claimSupportLabel>[0],
  verified: number | null,
  eligible: boolean
): string {
  if (eligible && verified !== null && support === "supports_claim") {
    return "Verified in notice";
  }
  if (support === "missing") {
    return claimSupportLabel(support);
  }
  if (!eligible) {
    return "Needs review";
  }
  if (support === "ambiguous") {
    return "Needs review";
  }
  if (support === "unverified" || support === "substring_only" || support === "insufficient") {
    return "Insufficient evidence";
  }
  return claimSupportLabel(support);
}

function isPlainTextFile(file: File): boolean {
  return file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");
}

export function ReadNoticeScreen(props: {
  text: string;
  onText: (text: string) => void;
  onLoadSample: () => void;
  grounded: GroundedNoticeViewModel;
  capability: ChromeCapabilityReport | null;
  onReadOnDevice: () => void;
  deviceMessage: string | null;
  reading: boolean;
}) {
  const [fileMessage, setFileMessage] = useState<string | null>(null);
  const limited =
    !props.capability ||
    props.capability.availability === "api_missing" ||
    props.capability.availability === "unavailable" ||
    props.capability.availability === "probe_error";
  const canAttempt =
    props.capability?.availability === "available" ||
    props.capability?.availability === "downloadable" ||
    props.capability?.availability === "downloading";
  const listed = props.grounded.eligibility.eligibleAmountsGBP;
  const rawVerified = props.grounded.amount.verifiedForDisplay;
  const amount =
    rawVerified !== null && listed.some((value) => Math.abs(value - rawVerified) < 0.001)
      ? rawVerified
      : null;

  return (
    <section className="stack" data-testid="screen-read">
      <header className="screen-header">
        <p className="screen-eyebrow">Screen 1</p>
        <h1 className="screen-title">Read the notice</h1>
        <p className="screen-lead">
          Paste a notice or open a .txt file. The figures on this screen come from the same local
          fact check as the action plan.
        </p>
      </header>
      {props.grounded.categoryDecision.needsConfirmation ||
      props.grounded.categoryDecision.modelIgnored ? (
        <div className="banner info" data-testid="category-guidance" role="status">
          {props.grounded.categoryDecision.needsConfirmation
            ? "The notice does not confirm one category, so specialist guidance was not selected."
            : "The on-device category did not match the notice text. Guidance follows the notice text."}
        </div>
      ) : null}
      {limited ? (
        <div className="banner" data-testid="limited-mode" role="status">
          <strong>Limited Mode.</strong> This browser has not made an on-device language model
          available. Amounts, dates, and quotes are read by local checks. The notice text is not
          sent to a cloud model.
        </div>
      ) : null}
      {props.capability?.availability === "downloadable" ||
      props.capability?.availability === "downloading" ? (
        <div className="banner info" role="status">
          Chrome can download the on-device model when you ask it to read this notice. That
          download stays on the device.
        </div>
      ) : null}
      <p data-testid="sample-label">Synthetic sample fixture</p>
      <div className="facts-grid">
        <article className="fact-tile">
          <span className="fact-label">Balance</span>
          <strong className={`fact-value${amount === null ? " is-missing" : ""}`} data-testid="read-amount">
            {amount === null ? "Not stated" : formatGbp(amount)}
          </strong>
          <span className="fact-pill fact-pill-warning" data-testid="read-amount-support">
            {amountSupportLabel(props.grounded.amount.support, amount, amount !== null)}
          </span>
          {props.grounded.amount.conflict ? (
            <span className="fact-pill fact-pill-warning" data-testid="read-amount-conflict">
              No current balance is established.{" "}
              {props.grounded.amount.amountsGBP.map((value) => formatGbp(value)).join(" and ")} are unverified. An
              empty amounts list means no supported outstanding balance.
            </span>
          ) : null}
          {props.grounded.amount.conditionalFeesGBP.length > 0 ? (
            <p className="fact-subnote" data-testid="read-conditional-fee">
              Conditional fee, not the balance:{" "}
              {props.grounded.amount.conditionalFeesGBP.map((value) => formatGbp(value)).join(", ")}
            </p>
          ) : null}
        </article>
        <article className="fact-tile">
          <span className="fact-label">Notice date</span>
          <strong className="fact-value">
            {props.grounded.issueDate.verifiedForDisplay &&
            props.grounded.eligibility.decisions.some(
              (item) => item.reason === "issue_date" && item.status === "ELIGIBLE"
            )
              ? props.grounded.issueDate.stated
              : "Not stated"}
          </strong>
        </article>
        <article className="fact-tile">
          <span className="fact-label">Response date</span>
          <strong className={`fact-value${props.grounded.responseDeadlines.stated ? "" : " is-missing"}`}>
            {props.grounded.responseDeadlines.conflicting
              ? "Multiple dates"
              : props.grounded.responseDeadlines.stated ?? "Not stated"}
          </strong>
        </article>
      </div>
      <div className="btn-row">
        <button type="button" className="btn secondary" onClick={props.onLoadSample}>
          Load synthetic energy sample
        </button>
        <label className="btn secondary">
          Open .txt
          <input
            className="sr-only"
            data-testid="notice-file"
            type="file"
            accept=".txt,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) {
                return;
              }
              if (!isPlainTextFile(file)) {
                setFileMessage("Only a .txt file can be opened. The current notice was left as it is.");
                return;
              }
              setFileMessage(null);
              void file.text().then((text) => props.onText(text));
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-testid="read-on-device"
          disabled={!canAttempt}
          onClick={props.onReadOnDevice}
        >
          {props.reading ? "Reading on this device" : "Read on this device"}
        </button>
      </div>
      {fileMessage ? <p role="status">{fileMessage}</p> : null}
      {props.deviceMessage ? (
        <p className="banner block" role="alert" data-testid="device-message">
          {props.deviceMessage}
        </p>
      ) : null}
      <label className="field">
        Notice text
        <textarea
          data-testid="notice-text"
          value={props.text}
          onChange={(event) => props.onText(event.target.value)}
          spellCheck={false}
        />
      </label>
    </section>
  );
}
