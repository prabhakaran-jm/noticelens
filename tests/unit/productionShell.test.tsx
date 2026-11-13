import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/App";
import { compareNoticeTexts } from "../../src/domain/compareNotices";
import { isoDateFromClock } from "../../src/domain/dates";
import { InferenceProvenanceError } from "../../src/domain/inferenceProvenance";
import { receiptForOnDeviceCall } from "../../src/ui/production/onDeviceSession";
import { normalizeNewlines } from "../../src/domain/textNormalize";

const original = normalizeNewlines(readFileSync("examples/energy-backbill-original.txt", "utf8"));
const revised = normalizeNewlines(readFileSync("examples/energy-backbill-revised.txt", "utf8"));

describe("production Civic Calm shell", () => {
  it("navigates the four screens and keeps cloud submission disabled", async () => {
    render(<App />);
    expect(await screen.findByTestId("limited-mode")).toBeInTheDocument();
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("sample-label")).toHaveTextContent("Synthetic sample fixture");
    expect(screen.queryByTestId("inference-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-on-device")).toBeDisabled();

    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("screen-plan")).toBeInTheDocument();
    expect(screen.getByTestId("plan-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("plan-period")).toHaveTextContent("January and June 2025");
    expect(screen.getByTestId("plan-reader")).toHaveTextContent("18 November 2026");

    fireEvent.click(screen.getByTestId("nav-compare"));
    const today = isoDateFromClock(new Date(), "Europe/London");
    const comparison = compareNoticeTexts(original, revised, { today });
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("£520");
    expect(screen.getByTestId("amount-difference")).toHaveTextContent("£760 lower");
    expect(screen.getByTestId("omission-alert")).toHaveTextContent(
      comparison.billingPeriod.omissionPrompt ?? ""
    );
    const revisedLabel = comparison.issueDate.revisedAssessment?.label;
    if (comparison.issueDate.revisedAssessment?.futureDatedFixture && revisedLabel) {
      expect(screen.getByTestId("future-date-banner")).toHaveTextContent(revisedLabel);
    }
    expect(screen.getByTestId("screen-compare")).toHaveTextContent("2 December 2026");
    expect(screen.getByTestId("screen-compare")).toHaveTextContent("18 November 2026");

    fireEvent.click(screen.getByTestId("nav-reply"));
    const send = screen.getByTestId("cloud-send-button");
    expect(send).toBeDisabled();
    expect(screen.getByTestId("cloud-disabled")).toHaveTextContent(/not connected/i);
    fireEvent.click(send);
    const exact = screen.getByTestId("exact-json").textContent ?? "";
    expect(exact.startsWith('{"schemaVersion":"noticelens.cloud-brief.v1"')).toBe(true);
    expect(exact).not.toContain("\n");
    expect(screen.getByTestId("formatted-json").textContent).toContain("\n");
    expect(screen.getByText(/does not guarantee/i)).toBeInTheDocument();
  });

  it("rejects a non-text file without replacing the notice", async () => {
    render(<App />);
    const before = (await screen.findByTestId("notice-text")) as HTMLTextAreaElement;
    const starting = before.value;
    const input = screen.getByTestId("notice-file") as HTMLInputElement;
    const pdf = new File(["%PDF-1.7"], "bill.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdf] } });
    expect(screen.getByTestId("notice-text")).toHaveValue(starting);
    expect(screen.getByText(/Only a \.txt file/)).toBeInTheDocument();
  });

  it("records an on-device receipt only from the reported source", () => {
    expect(() =>
      receiptForOnDeviceCall({
        output: {
          noticeCategory: "utility_electricity",
          issueDate: "18 November 2026",
          billingPeriod: "not stated",
          amountGBP: null,
          responseDeadline: "",
          obligations: [],
        },
        rawResponseText: "must not be stored",
        inferenceSource: "in_cloud",
        latencyMs: 10,
      })
    ).toThrow(InferenceProvenanceError);

    const receipt = receiptForOnDeviceCall({
      output: {
        noticeCategory: "utility_electricity",
        issueDate: "18 November 2026",
        billingPeriod: "not stated",
        amountGBP: 1280,
        responseDeadline: "25 November 2026",
        obligations: [],
      },
      rawResponseText: "must not be stored",
      inferenceSource: "on_device",
      latencyMs: 42,
    });
    expect(receipt.inferenceSource).toBe("on_device");
    expect(receipt.latencyMs).toBe(42);
    expect(JSON.stringify(receipt)).not.toContain("must not be stored");
  });
});
