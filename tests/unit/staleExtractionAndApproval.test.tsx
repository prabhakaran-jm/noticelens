import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED, requestCloudSubmission } from "../../src/adapters/cloudApprovalSession";
import { buildClosedCloudInspection } from "../../src/adapters/closedCloudInspection";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import {
  identifierContextKey,
  privacyApprovalView,
  recordClosedBriefApproval,
  requestApprovedCloudSend,
  requestClosedBriefSend,
  resetUserApprovalStateForTests,
} from "../../src/adapters/privacyApproval";
import type { InferenceCallRecord, RawNoticeExtraction } from "../../src/domain/types";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import { App } from "../../src/App";
import { PrivacyApprovalModal, payloadConfirmationMatches } from "../../src/ui/privacy/PrivacyApprovalModal";

const harness = vi.hoisted(() => {
  const pending: Array<{
    text: string;
    resolve: (value: InferenceCallRecord<RawNoticeExtraction>) => void;
  }> = [];
  return {
    pending,
    runOnDeviceNoticeExtraction: (text: string) =>
      new Promise<InferenceCallRecord<RawNoticeExtraction>>((resolve) => {
        pending.push({ text, resolve });
      }),
    probe: () =>
      Promise.resolve({
        hasLanguageModelGlobal: true,
        availability: "available" as const,
        userAgent: "test",
        isOnline: false,
        errorDetail: null,
        checkedAtIso: "2026-11-14T00:00:00.000Z",
      }),
  };
});

vi.mock("../../src/ai/onDeviceExtractor", () => ({
  runOnDeviceNoticeExtraction: harness.runOnDeviceNoticeExtraction,
}));

vi.mock("../../src/ai/capability", async () => {
  const actual = await vi.importActual<typeof import("../../src/ai/capability")>("../../src/ai/capability");
  return {
    ...actual,
    probeChromeLanguageModelAvailability: harness.probe,
  };
});

const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const noticeB = "Please contact our billing team to discuss the account.";
const payQuote =
  "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.";
const meterQuote =
  "If you believe you have already provided meter readings or there is an error, please provide the relevant records when you contact us.";
const balanceQuote =
  "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.";

function extractionRecord(
  quote: string,
  latencyMs: number,
  inferenceSource: string | undefined = "on_device"
): InferenceCallRecord<RawNoticeExtraction> {
  return {
    output: {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: 1280,
      responseDeadline: "25 November 2026",
      obligations: [{ action: "Read the notice", dueDate: null, sourceQuote: quote }],
    },
    rawResponseText: "must not be stored",
    inferenceSource,
    latencyMs,
  };
}

async function renderReady(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("read-on-device")).toBeEnabled());
}

function startRead(): void {
  fireEvent.click(screen.getByTestId("read-on-device"));
}

async function resolveRequest(index: number, record: InferenceCallRecord<RawNoticeExtraction>): Promise<void> {
  const request = harness.pending[index];
  if (!request) {
    throw new Error(`missing on-device request ${index}`);
  }
  await act(async () => {
    request.resolve(record);
  });
}

function replaceNotice(text: string): void {
  fireEvent.change(screen.getByTestId("notice-text"), { target: { value: text } });
}

function openPrivacy(): void {
  fireEvent.click(screen.getByTestId("nav-reply"));
  fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
}

function tickReview(): void {
  fireEvent.click(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" }));
}

function exactPayload(): string {
  return (screen.getByTestId("privacy-exact-json").textContent ?? "").trim();
}

function clickApproveEvenIfDisabled(): void {
  const button = screen.getByTestId("privacy-approve");
  button.removeAttribute("disabled");
  fireEvent.click(button);
}

describe("stale on-device extraction", () => {
  beforeEach(() => {
    harness.pending.length = 0;
  });

  it("discards notice A after the notice was edited to B", async () => {
    await renderReady();
    startRead();
    expect(harness.pending).toHaveLength(1);
    expect(harness.pending[0]?.text).toBe(original);
    replaceNotice(noticeB);
    await resolveRequest(0, extractionRecord(meterQuote, 11));
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Contact the sender");
    expect(screen.getByTestId("screen-plan")).not.toHaveTextContent("Provide records");
    expect(screen.getByTestId("screen-plan")).not.toHaveTextContent("Pay or contact the sender");
    fireEvent.click(screen.getByTestId("nav-read"));
    expect(screen.getByTestId("read-amount")).toHaveTextContent("Not stated");
    fireEvent.click(screen.getByTestId("capability-pill"));
    expect(screen.getByTestId("evidence-empty")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("must not be stored");
  });

  it("discards notice A after an edit back to the same text", async () => {
    await renderReady();
    const starting = (screen.getByTestId("notice-text") as HTMLTextAreaElement).value;
    startRead();
    replaceNotice(noticeB);
    replaceNotice(starting);
    await resolveRequest(0, extractionRecord(meterQuote, 11));
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Pay or contact the sender");
    expect(screen.getByTestId("screen-plan")).not.toHaveTextContent("Provide records");
    fireEvent.click(screen.getByTestId("capability-pill"));
    expect(screen.getByTestId("evidence-empty")).toBeInTheDocument();
  });

  it("applies only the newest request when two resolve out of order", async () => {
    await renderReady();
    startRead();
    startRead();
    expect(harness.pending).toHaveLength(2);
    await resolveRequest(0, extractionRecord(balanceQuote, 99));
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Pay or contact the sender");
    expect(screen.getByTestId("screen-plan")).not.toHaveTextContent("Review the stated obligation");
    fireEvent.click(screen.getByTestId("nav-read"));
    await resolveRequest(1, extractionRecord(meterQuote, 12));
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Provide records");
    fireEvent.click(screen.getByTestId("capability-pill"));
    expect(screen.getByText("12 ms")).toBeInTheDocument();
    expect(screen.queryByText("99 ms")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByTestId("nav-read"));
    startRead();
    startRead();
    await resolveRequest(3, extractionRecord(payQuote, 21));
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Pay or contact the sender");
    await resolveRequest(2, extractionRecord(balanceQuote, 98));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Pay or contact the sender");
    expect(screen.getByTestId("screen-plan")).not.toHaveTextContent("Review the stated obligation");
    fireEvent.click(screen.getByTestId("capability-pill"));
    expect(screen.getByText("21 ms")).toBeInTheDocument();
    expect(screen.queryByText("98 ms")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("must not be stored");
  });

  it("applies the current on-device result and rejects a wrong inference source", async () => {
    await renderReady();
    startRead();
    await resolveRequest(0, extractionRecord(meterQuote, 12));
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Provide records");
    expect(screen.getByTestId("plan-action-support")).toHaveTextContent("Verified in notice");
    fireEvent.click(screen.getByTestId("capability-pill"));
    expect(screen.getAllByText("on_device").length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent("must not be stored");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByTestId("nav-read"));
    startRead();
    await resolveRequest(1, extractionRecord(payQuote, 13, "in_cloud"));
    expect(screen.getByTestId("device-message")).toHaveTextContent(/provenance did not match/i);
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Provide records");
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("exact-json").textContent).toContain("provide_records");
    expect(screen.getByTestId("exact-json").textContent).not.toContain("pay_or_contact");
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not revive an approval from a stale extraction", async () => {
    await renderReady();
    openPrivacy();
    tickReview();
    fireEvent.click(screen.getByTestId("privacy-approve"));
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByTestId("nav-read"));
    startRead();
    replaceNotice(noticeB);
    await resolveRequest(0, extractionRecord(meterQuote, 11));
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Contact the sender");
    fireEvent.click(screen.getByTestId("nav-read"));
    replaceNotice(original);
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("capability-pill"));
    expect(screen.getByTestId("evidence-empty")).toBeInTheDocument();
  });
});

describe("approval confirmation bound to the exact payload", () => {
  beforeEach(() => {
    harness.pending.length = 0;
    resetUserApprovalStateForTests();
  });

  it("approves payload A only after the checkbox is ticked", async () => {
    await renderReady();
    openPrivacy();
    expect(screen.getByTestId("privacy-approve")).toBeDisabled();
    tickReview();
    fireEvent.click(screen.getByTestId("privacy-approve"));
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(screen.getAllByText(/Cloud sending disabled/i).length).toBeGreaterThan(0);
  });

  it("disables approval when the payload changes after the checkbox is ticked", async () => {
    await renderReady();
    openPrivacy();
    tickReview();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    expect(screen.getByTestId("privacy-approve")).toBeDisabled();
    expect(exactPayload()).toContain("confirm_payment_plan_options");
    clickApproveEvenIfDisabled();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
  });

  it("keeps approval invalid when the original payload returns without a new confirmation", async () => {
    await renderReady();
    openPrivacy();
    tickReview();
    fireEvent.click(screen.getByTestId("privacy-approve"));
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "request_billing_review" },
    });
    expect(exactPayload()).toContain("request_billing_review");
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    clickApproveEvenIfDisabled();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
  });

  it("clears confirmation when the identifier context changes and the JSON does not", async () => {
    await renderReady();
    openPrivacy();
    const before = exactPayload();
    tickReview();
    fireEvent.click(screen.getByTestId("nav-read"));
    const notice = screen.getByTestId("notice-text") as HTMLTextAreaElement;
    replaceNotice(`${notice.value}\nKeeper token JONES-1001`);
    expect(exactPayload()).toBe(before);
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    clickApproveEvenIfDisabled();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    replaceNotice(original);
    expect(exactPayload()).toBe(before);
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
  });

  it("clears confirmation when only the document generation changes", async () => {
    await renderReady();
    openPrivacy();
    const before = exactPayload();
    tickReview();
    fireEvent.click(screen.getByTestId("nav-read"));
    fireEvent.click(screen.getByRole("button", { name: "Load synthetic energy sample" }));
    expect(exactPayload()).toBe(before);
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    expect(screen.getByTestId("privacy-approve")).toBeDisabled();
    clickApproveEvenIfDisabled();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
  });

  it("drops confirmation when a current extraction changes the bytes while the modal stays open", async () => {
    await renderReady();
    startRead();
    openPrivacy();
    const before = exactPayload();
    expect(before).toContain("pay_or_contact");
    tickReview();
    await resolveRequest(0, extractionRecord(meterQuote, 12));
    const after = exactPayload();
    expect(after).not.toBe(before);
    expect(after).toContain("provide_records");
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    clickApproveEvenIfDisabled();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("does not approve when the checkbox was never ticked", async () => {
    await renderReady();
    openPrivacy();
    expect(screen.getByTestId("privacy-approve")).toBeDisabled();
    clickApproveEvenIfDisabled();
    expect(screen.queryByTestId("privacy-approved")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("still rejects a reused approval and a forged identifier context", () => {
    resetUserApprovalStateForTests();
    const view = groundNoticeFacts({ rawNoticeText: original, today: "2026-11-13" });
    const inspection = buildClosedCloudInspection({
      rawNoticeText: original,
      view,
      responseGoal: "request_billing_review",
    });
    const serialized = inspection.exactSerialized ?? "";
    const approval = recordClosedBriefApproval(serialized, serialized, 2, inspection.guardOptions);
    expect(
      privacyApprovalView({
        serialized,
        limitations: [],
        approval,
        generation: 2,
        guardOptions: { forbiddenIdentifiers: ["forged-context"] },
      }).matchesCurrentPayload
    ).toBe(false);
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
    expect(() =>
      requestCloudSubmission({
        cloudSendEnabled: false,
        approval: null,
        canonical: null,
        violations: [],
        blockedReason: "Cloud submission is not connected.",
      })
    ).toThrow(/not connected/i);
    expect(() => requestClosedBriefSend(approval)).toThrow(/not connected/i);
    expect(() => requestApprovedCloudSend(approval)).toThrow(/already been used/i);
    expect(identifierContextKey(inspection.guardOptions)).not.toBe(identifierContextKey({ forbiddenIdentifiers: ["forged-context"] }));
  });

  it("clears a tick when only the identifier context or generation prop changes", () => {
    const onApprove = vi.fn();
    const view = {
      serialized: "{\"schemaVersion\":\"noticelens.cloud-brief.v2\"}",
      limitations: [],
      approval: null,
      matchesCurrentPayload: false,
      cloudSendEnabled: false as const,
      blockedReason: "Cloud submission is not connected.",
    };
    const { rerender } = render(
      <PrivacyApprovalModal
        open
        view={view}
        generation={4}
        identifierContext='["Sarah Example"]'
        onApprove={onApprove}
        onClose={() => undefined}
      />
    );
    tickReview();
    expect(screen.getByTestId("privacy-approve")).toBeEnabled();
    rerender(
      <PrivacyApprovalModal
        open
        view={view}
        generation={4}
        identifierContext='["JONES-1001","Sarah Example"]'
        onApprove={onApprove}
        onClose={() => undefined}
      />
    );
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    clickApproveEvenIfDisabled();
    expect(onApprove).not.toHaveBeenCalled();
    rerender(
      <PrivacyApprovalModal
        open
        view={view}
        generation={4}
        identifierContext='["Sarah Example"]'
        onApprove={onApprove}
        onClose={() => undefined}
      />
    );
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    rerender(
      <PrivacyApprovalModal
        open
        view={view}
        generation={5}
        identifierContext='["Sarah Example"]'
        onApprove={onApprove}
        onClose={() => undefined}
      />
    );
    tickReview();
    rerender(
      <PrivacyApprovalModal
        open
        view={{ ...view, serialized: "{\"schemaVersion\":\"noticelens.cloud-brief.v2\",\"changed\":true}" }}
        generation={5}
        identifierContext='["Sarah Example"]'
        onApprove={onApprove}
        onClose={() => undefined}
      />
    );
    expect(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" })).not.toBeChecked();
    clickApproveEvenIfDisabled();
    expect(onApprove).not.toHaveBeenCalled();
    expect(
      payloadConfirmationMatches(
        { serialized: view.serialized, generation: 4, identifierContext: '["Sarah Example"]' },
        view.serialized,
        4,
        '["JONES-1001","Sarah Example"]'
      )
    ).toBe(false);
  });
});
