import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SUBMISSION_ENABLED } from "../../src/adapters/cloudApprovalSession";
import type { NoticeComparison } from "../../src/domain/compareNotices";
import { App } from "../../src/App";
import { CompareUpdateScreen, differenceBadgeClass } from "../../src/ui/screens/CompareUpdateScreen";
import { clearCoreFirebaseEnv, stubCoreFirebaseEnv } from "./stubCoreFirebaseEnv";

const harness = vi.hoisted(() => ({
  calls: [] as string[],
  availability: "available" as "available" | "unavailable" | "downloadable" | "api_missing",
}));

vi.mock("../../src/ai/onDeviceExtractor", () => ({
  runOnDeviceNoticeExtraction: (text: string) => {
    harness.calls.push(text);
    return new Promise(() => undefined);
  },
}));

vi.mock("../../src/ai/capability", async () => {
  const actual = await vi.importActual<typeof import("../../src/ai/capability")>("../../src/ai/capability");
  return {
    ...actual,
    probeChromeLanguageModelAvailability: () =>
      Promise.resolve({
        hasLanguageModelGlobal: harness.availability !== "api_missing",
        availability: harness.availability,
        userAgent: "test",
        isOnline: false,
        errorDetail: null,
        checkedAtIso: "2026-11-20T00:00:00.000Z",
      }),
  };
});

function comparison(overrides: {
  relationship: NoticeComparison["relationship"];
  differenceGBP?: number | null;
  originalAuthority?: NoticeComparison["amount"]["originalAuthority"];
  revisedAuthority?: NoticeComparison["amount"]["revisedAuthority"];
}): NoticeComparison {
  const originalAuthority = overrides.originalAuthority ?? "verified";
  const revisedAuthority = overrides.revisedAuthority ?? "verified";
  return {
    relationship: overrides.relationship,
    amount: {
      value: 1280,
      originalAuthority,
      revised: 520,
      revisedAuthority,
      differenceGBP: overrides.differenceGBP ?? null,
    },
    issueDate: {
      original: "18 November 2026",
      originalAuthority: "verified",
      revised: "2 December 2026",
      revisedAuthority: "verified",
    },
    responseDeadline: {
      value: "25 November 2026",
      originalAuthority: "verified",
      originalRole: "payment",
      revised: "16 December 2026",
      revisedAuthority: "verified",
      revisedRole: "contact",
    },
    billingPeriod: { omittedInRevised: false, verifiedForDisplay: "January and June 2025", revised: null },
  } as NoticeComparison;
}

afterEach(() => {
  cleanup();
  harness.calls.length = 0;
  harness.availability = "available";
  vi.unstubAllEnvs();
});

describe("submission polish", () => {
  it("styles only a verified reduction as a reduction", () => {
    const reduced = comparison({ relationship: "COMPARABLE", differenceGBP: -760 });
    const unverified = comparison({ relationship: "RELATIONSHIP_UNVERIFIED" });
    const different = comparison({ relationship: "NOT_COMPARABLE" });
    const unstated = comparison({
      relationship: "RELATIONSHIP_UNVERIFIED",
      originalAuthority: "not_stated",
      revisedAuthority: "not_stated",
    });
    expect(differenceBadgeClass(reduced)).toBe("delta-badge-reduced");
    expect(differenceBadgeClass(unverified)).toBe("delta-badge-review");
    expect(differenceBadgeClass(different)).toBe("delta-badge-neutral");
    expect(differenceBadgeClass(unstated)).toBe("delta-badge-neutral");

    const { rerender } = render(
      <CompareUpdateScreen originalText="original" revisedText="revised" onRevisedText={() => undefined} comparison={unverified} />
    );
    expect(screen.getByTestId("difference-badge")).toHaveClass("delta-badge-review");
    expect(screen.getByTestId("difference-badge")).toHaveTextContent("Needs review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");

    rerender(
      <CompareUpdateScreen originalText="original" revisedText="revised" onRevisedText={() => undefined} comparison={different} />
    );
    expect(screen.getByTestId("difference-badge")).toHaveClass("delta-badge-neutral");
    expect(screen.getByTestId("difference-badge")).toHaveTextContent("Different liabilities");

    rerender(
      <CompareUpdateScreen originalText="original" revisedText="revised" onRevisedText={() => undefined} comparison={unstated} />
    );
    expect(screen.getByTestId("difference-badge")).toHaveClass("delta-badge-neutral");
    expect(screen.getByTestId("difference-badge")).toHaveTextContent("Not stated");

    rerender(
      <CompareUpdateScreen originalText="original" revisedText="revised" onRevisedText={() => undefined} comparison={reduced} />
    );
    expect(screen.getByTestId("difference-badge")).toHaveClass("delta-badge-reduced");
    expect(screen.getByTestId("difference-badge")).toHaveTextContent("£760 lower");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("recovered");
  });

  it("does not start Read when Firebase config is missing, even if a model is available", async () => {
    clearCoreFirebaseEnv();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("firebase-config-missing")).toHaveTextContent(".env.example");
    expect(screen.getByTestId("firebase-config-missing")).toHaveTextContent("docs/JUDGING.md");
    expect(screen.getByTestId("firebase-config-missing").textContent).not.toMatch(/AIza|test-key/);
    expect(screen.getByTestId("read-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("read-on-device")).toBeDisabled();
    fireEvent.click(screen.getByTestId("read-on-device"));
    expect(harness.calls).toHaveLength(0);
    fireEvent.click(screen.getByTestId("nav-plan"));
    expect(screen.getByTestId("screen-plan")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-reply"));
    expect(screen.getByTestId("exact-json")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-compare"));
    expect(screen.getByTestId("compare-original-amount")).toHaveTextContent("£1,280");
    expect(screen.getByTestId("compare-revised-amount")).toHaveTextContent("£520");
    expect(screen.getByTestId("difference-badge")).toHaveClass("delta-badge-review");
    expect(screen.getByTestId("amount-difference")).not.toHaveTextContent("£760");
  });

  it("keeps Read available when Firebase config and the model are present", async () => {
    stubCoreFirebaseEnv();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("firebase-config-missing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("limited-mode")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-on-device")).toBeEnabled();
    fireEvent.click(screen.getByTestId("read-on-device"));
    expect(harness.calls).toHaveLength(1);
  });

  it("keeps a downloadable model eligible only when Firebase config is present", async () => {
    harness.availability = "downloadable";
    clearCoreFirebaseEnv();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("read-on-device")).toBeDisabled();
    expect(screen.queryByText(/Chrome can download the on-device model/)).not.toBeInTheDocument();
    cleanup();
    stubCoreFirebaseEnv();
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Chrome can download the on-device model/)).toBeInTheDocument();
    expect(screen.getByTestId("read-on-device")).toBeEnabled();
  });

  it("keeps Limited Mode when the model cannot run", async () => {
    stubCoreFirebaseEnv();
    harness.availability = "unavailable";
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("limited-mode")).toHaveTextContent("Limited Mode");
    expect(screen.getByTestId("read-on-device")).toBeDisabled();
    fireEvent.click(screen.getByTestId("read-on-device"));
    expect(harness.calls).toHaveLength(0);
  });

  it("links the disabled Send control to the cloud-disabled notice", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId("nav-reply"));
    const send = screen.getByTestId("cloud-send-button");
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("aria-describedby", "cloud-disabled");
    expect(document.getElementById("cloud-disabled")).toBe(screen.getByTestId("cloud-disabled"));
    expect(screen.getByTestId("cloud-copy-button")).toBeDisabled();
    expect(screen.getByTestId("cloud-download-button")).toBeDisabled();
    expect(screen.getByTestId("cloud-disabled")).toHaveTextContent(/Cloud sending disabled/i);
    expect(screen.getByTestId("structural-validation-warning")).toBeInTheDocument();
    expect(screen.getByText(/Understand the notice. Check the source./)).toBeInTheDocument();
    expect(screen.getByText("3. Review response brief")).toBeInTheDocument();
    expect(screen.queryByTestId("real-cloud-diagnostic")).not.toBeInTheDocument();
    expect(CLOUD_SUBMISSION_ENABLED).toBe(false);
  });
});
