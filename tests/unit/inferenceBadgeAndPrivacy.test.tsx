import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCloudDraftFromApprovedPayload } from "../../src/ai/cloudDrafter";
import {
  FirebaseSetupBlockerError,
  getConfiguredCloudModelName,
} from "../../src/config/firebase";
import { CloudPayloadValidationError } from "../../src/domain/cloudPayloadGuard";
import {
  BENCHMARK_NOTICE_FIXTURES,
  M0_SMOKE_TEST_CLOUD_PAYLOAD,
} from "../../src/fixtures/benchmarkNotices";
import {
  InferenceBadge,
  resolveInferenceBadgeState,
} from "../../src/ui/InferenceBadge";
import { SpikeHarness } from "../../src/ui/SpikeHarness";

describe("InferenceBadge & SpikeHarness privacy/scope guardrails (automated mocked tests)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders ON_DEVICE or IN_CLOUD only when exact lowercase SDK InferenceSource strings match", () => {
    expect(resolveInferenceBadgeState("on_device").status).toBe(
      "verified_on_device"
    );
    expect(resolveInferenceBadgeState("in_cloud").status).toBe(
      "verified_in_cloud"
    );
    expect(resolveInferenceBadgeState("ON_DEVICE").status).toBe("unverified");
    expect(resolveInferenceBadgeState(undefined).status).toBe("unverified");

    render(
      <InferenceBadge actualInferenceSource="on_device" contextLabel="test" />
    );
    expect(screen.getByTestId("inference-badge-test")).toHaveAttribute(
      "data-inference-status",
      "verified_on_device"
    );
  });

  it("blocks cloudDrafter before Firebase initialization when payload violates strict allowlist", async () => {
    await expect(
      runCloudDraftFromApprovedPayload({
        ...M0_SMOKE_TEST_CLOUD_PAYLOAD,
        unexpectedRawNotice: "Dear Sarah Example, RG0 0AA",
      })
    ).rejects.toThrow(CloudPayloadValidationError);
  });

  it("rejects retired or deprecated Gemini 1.5/2.0/2.5 cloud models", () => {
    expect(getConfiguredCloudModelName()).toBe("gemini-3.5-flash-lite");

    vi.stubEnv("VITE_FIREBASE_CLOUD_MODEL", "gemini-2.5-flash");
    expect(() => getConfiguredCloudModelName()).toThrow(
      FirebaseSetupBlockerError
    );

    vi.stubEnv("VITE_FIREBASE_CLOUD_MODEL", "gemini-2.0-flash");
    expect(() => getConfiguredCloudModelName()).toThrow(
      FirebaseSetupBlockerError
    );
  });

  it("rejects non-.txt uploads (such as .pdf or .png) without reading or overwriting notice text", async () => {
    render(<SpikeHarness />);
    await screen.findByTestId("chrome-lm-global");

    const fileInput = screen.getByTestId(
      "input-txt-upload"
    ) as HTMLInputElement;
    const readSpy = vi.fn();
    const pdfFile = Object.assign(
      new File(["%PDF-1.7 fake"], "Energy-Bill.pdf", {
        type: "application/pdf",
      }),
      { text: readSpy }
    );

    fireEvent.change(fileInput, { target: { files: [pdfFile] } });

    const alert = await screen.findByTestId("input-scope-warning");
    expect(alert).toHaveTextContent(/accepts plain text \(\.txt\) files only/i);
    expect(readSpy).not.toHaveBeenCalled();
    expect(
      (screen.getByTestId("textarea-notice") as HTMLTextAreaElement).value
    ).toBe(BENCHMARK_NOTICE_FIXTURES[0]!.rawText);
  });
});
