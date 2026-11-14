import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { groundNoticeFacts } from "../../src/adapters/groundNoticeFacts";
import { App } from "../../src/App";
import { compareNoticeTexts } from "../../src/domain/compareNotices";
import { isoDateFromClock } from "../../src/domain/dates";
import { InferenceProvenanceError } from "../../src/domain/inferenceProvenance";
import { normalizeNewlines } from "../../src/domain/textNormalize";
import type { RawNoticeExtraction } from "../../src/domain/types";
import { receiptForOnDeviceCall } from "../../src/ui/production/onDeviceSession";
import { ActionPlanScreen } from "../../src/ui/screens/ActionPlanScreen";

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
    expect(screen.getByTestId("plan-action-heading")).toHaveTextContent("Pay or contact the sender");
    expect(screen.getByTestId("plan-action-heading")).not.toHaveTextContent("court hearing");
    expect(screen.getByTestId("plan-action-support")).toHaveTextContent("Verified in notice");
    expect(screen.getByTestId("plan-reader").querySelector("mark.quote-mark")?.textContent).toContain(
      "Please pay the balance or contact our billing team"
    );

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

  it("records a local privacy approval and clears it when the brief changes", async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId("nav-reply"));
    const send = screen.getByTestId("cloud-send-button");
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review privacy approval" }));
    const exact = screen.getByTestId("privacy-exact-json").textContent ?? "";
    expect(exact.startsWith('{"schemaVersion":"noticelens.cloud-brief.v1"')).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I have reviewed this exact payload" }));
    fireEvent.click(screen.getByTestId("privacy-approve"));
    expect(screen.getByTestId("privacy-approved")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("privacy-current")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "confirm_payment_plan_options" },
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();

    fireEvent.click(screen.getByTestId("nav-plan"));
    fireEvent.change(screen.getByLabelText("What you want the reply to ask"), {
      target: { value: "request_billing_review" },
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.queryByTestId("privacy-current")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-send-button")).toBeDisabled();
  });

  it("keeps invented action wording off the verified heading", () => {
    const payQuote =
      "Please pay the balance or contact our billing team by 25 November 2026 to discuss your account.";
    const balanceQuote =
      "Our records show an outstanding balance of £1,280 for electricity supplied between January and June 2025.";
    const extraction: RawNoticeExtraction = {
      noticeCategory: "utility_electricity",
      issueDate: "18 November 2026",
      billingPeriod: "January and June 2025",
      amountGBP: 1280,
      responseDeadline: "25 November 2026",
      obligations: [
        {
          action: "Attend a court hearing about this debt",
          dueDate: null,
          sourceQuote: payQuote,
        },
        {
          action: "Pay £4,400",
          dueDate: null,
          sourceQuote: payQuote,
        },
        {
          action: "Contact the sender by 3 January 2027",
          dueDate: "3 January 2027",
          sourceQuote: payQuote,
        },
        {
          action: "Pay the balance",
          dueDate: null,
          sourceQuote: "Please pay the balance…",
        },
        {
          action: "Attend a court hearing about this debt",
          dueDate: null,
          sourceQuote: balanceQuote,
        },
      ],
    };
    const view = groundNoticeFacts({
      rawNoticeText: original,
      today: "2026-11-13",
      extraction,
    });
    render(
      <ActionPlanScreen
        view={view}
        identifiers={[]}
        responseGoal="request_billing_review"
        onResponseGoal={() => undefined}
        flags={[]}
        onFlags={() => undefined}
      />
    );
    const cards = screen.getAllByTestId("plan-action-card");
    expect(cards).toHaveLength(5);
    expect(within(cards[0]!).getByTestId("plan-action-heading")).toHaveTextContent(
      "Pay or contact the sender"
    );
    expect(within(cards[0]!).getByTestId("plan-action-heading")).not.toHaveTextContent(
      "court hearing"
    );
    expect(cards[0]).not.toHaveTextContent("Attend a court hearing");
    expect(within(cards[0]!).getByTestId("plan-action-support")).toHaveTextContent(
      "Verified in notice"
    );
    expect(within(cards[1]!).getByTestId("plan-action-heading")).toHaveTextContent(
      "Pay or contact the sender"
    );
    expect(cards[1]).not.toHaveTextContent("£4,400");
    expect(cards[1]).not.toHaveTextContent("Verified in notice");
    expect(within(cards[2]!).getByTestId("plan-action-heading")).toHaveTextContent(
      "Pay or contact the sender"
    );
    expect(cards[2]).not.toHaveTextContent("3 January 2027");
    expect(cards[2]).not.toHaveTextContent("Verified in notice");
    expect(within(cards[3]!).getByTestId("plan-action-heading")).toHaveTextContent(
      "Pay the stated balance"
    );
    expect(within(cards[3]!).getByTestId("plan-action-support")).toHaveTextContent(
      "Incomplete quote"
    );
    expect(cards[3]).not.toHaveTextContent("Verified in notice");
    expect(within(cards[4]!).getByTestId("plan-action-heading")).toHaveTextContent(
      "Review the stated obligation"
    );
    expect(cards[4]).not.toHaveTextContent("Attend a court hearing");
    expect(cards[4]).not.toHaveTextContent("Verified in notice");
    expect(within(cards[4]!).getByTestId("plan-action-support")).toHaveTextContent(
      "Insufficient evidence"
    );
    const highlighted = [...screen.getByTestId("plan-reader").querySelectorAll("mark.quote-mark")]
      .map((node) => node.textContent ?? "")
      .join("\n");
    expect(highlighted).toContain(payQuote);
    expect(highlighted).toContain(balanceQuote);
  });
});
