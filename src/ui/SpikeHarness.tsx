import { useEffect, useState, type ChangeEvent } from "react";
import {
  probeChromeLanguageModelAvailability,
  type ChromeCapabilityReport,
} from "../ai/capability";
import {
  runCloudDraftFromApprovedPayload,
  type CloudDraftCallResult,
} from "../ai/cloudDrafter";
import { runOnDeviceNoticeExtraction } from "../ai/onDeviceExtractor";
import {
  evaluateExtraction,
  summarizeBenchmarkSuite,
  type BenchmarkSuiteSummary,
  type FixtureBenchmarkEvaluation,
} from "../benchmark/evaluateExtraction";
import {
  getFirebaseEnvDiagnostics,
  type FirebaseEnvDiagnostics,
} from "../config/firebase";
import { validateCloudBoundPayload } from "../domain/cloudPayloadGuard";
import type { VerifiedNoticeExtraction } from "../domain/types";
import { attachQuoteVerification } from "../domain/verifyQuotes";
import {
  BENCHMARK_NOTICE_FIXTURES,
  M0_SMOKE_TEST_CLOUD_PAYLOAD,
} from "../fixtures/benchmarkNotices";
import { InferenceBadge } from "./InferenceBadge";

interface OnDeviceRunDisplay {
  verifiedExtraction: VerifiedNoticeExtraction;
  rawResponseText: string;
  inferenceSource: string | undefined;
  latencyMs: number;
  onlineAtExecution: boolean;
  executedAtIso: string;
}

export function SpikeHarness() {
  const [envDiag] = useState<FirebaseEnvDiagnostics>(() =>
    getFirebaseEnvDiagnostics()
  );
  const [chromeReport, setChromeReport] =
    useState<ChromeCapabilityReport | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string>(
    BENCHMARK_NOTICE_FIXTURES[0]?.id ?? "energy-backbill-original"
  );
  const [noticeText, setNoticeText] = useState<string>(
    BENCHMARK_NOTICE_FIXTURES[0]?.rawText ?? ""
  );
  const [inputWarning, setInputWarning] = useState<string | null>(null);

  const [onDeviceRunning, setOnDeviceRunning] = useState(false);
  const [downloadProgressPct, setDownloadProgressPct] = useState<number | null>(
    null
  );
  const [onDeviceResult, setOnDeviceResult] =
    useState<OnDeviceRunDisplay | null>(null);
  const [onDeviceError, setOnDeviceError] = useState<string | null>(null);

  const [cloudRunning, setCloudRunning] = useState(false);
  const [cloudResult, setCloudResult] = useState<CloudDraftCallResult | null>(
    null
  );
  const [cloudError, setCloudError] = useState<string | null>(null);

  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkProgressLabel, setBenchmarkProgressLabel] = useState<
    string | null
  >(null);
  const [benchmarkSummary, setBenchmarkSummary] =
    useState<BenchmarkSuiteSummary | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const refreshChromeCapability = async () => {
    const report = await probeChromeLanguageModelAvailability();
    setChromeReport(report);
  };

  useEffect(() => {
    void refreshChromeCapability();
  }, []);

  const handleSelectFixture = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setSelectedFixtureId(id);
    const found = BENCHMARK_NOTICE_FIXTURES.find((f) => f.id === id);
    if (found) {
      setNoticeText(found.rawText);
      setInputWarning(null);
    }
  };

  const handleTxtFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isPlainTxt =
      file.name.toLowerCase().endsWith(".txt") || file.type === "text/plain";
    if (!isPlainTxt) {
      setInputWarning(
        `Rejected "${file.name}": Milestone 0 / MVP scope accepts plain text (.txt) files only. Image and PDF inputs are deferred until independent local text extraction is verified.`
      );
      e.target.value = "";
      return;
    }

    const content = await file.text();
    setNoticeText(content);
    setSelectedFixtureId("custom-txt");
    setInputWarning(null);
  };

  const handleRunOnDevice = async () => {
    setOnDeviceRunning(true);
    setOnDeviceError(null);
    setOnDeviceResult(null);
    setDownloadProgressPct(null);

    try {
      const onlineAtExecution =
        typeof navigator !== "undefined" ? navigator.onLine : false;
      const callRecord = await runOnDeviceNoticeExtraction(noticeText, {
        onDownloadProgress: (p) => {
          setDownloadProgressPct(Math.round(p * 10000) / 100);
        },
      });
      const verifiedExtraction = attachQuoteVerification(
        noticeText,
        callRecord.output
      );
      setOnDeviceResult({
        verifiedExtraction,
        rawResponseText: callRecord.rawResponseText,
        inferenceSource: callRecord.inferenceSource,
        latencyMs: callRecord.latencyMs,
        onlineAtExecution,
        executedAtIso: new Date().toISOString(),
      });
    } catch (err) {
      setOnDeviceError(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      );
    } finally {
      setOnDeviceRunning(false);
    }
  };

  const handleRunInCloud = async () => {
    setCloudRunning(true);
    setCloudError(null);
    setCloudResult(null);

    try {
      const selectedFixture = BENCHMARK_NOTICE_FIXTURES.find(
        (f) => f.id === selectedFixtureId
      );
      const res = await runCloudDraftFromApprovedPayload(
        M0_SMOKE_TEST_CLOUD_PAYLOAD,
        {
          rawNoticeText: noticeText,
          forbiddenIdentifiers: selectedFixture?.forbiddenPiiTokens ?? [],
        }
      );
      setCloudResult(res);
    } catch (err) {
      setCloudError(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      );
    } finally {
      setCloudRunning(false);
    }
  };

  const handleRunFiveFixtureBenchmark = async () => {
    setBenchmarkRunning(true);
    setBenchmarkError(null);
    setBenchmarkSummary(null);

    try {
      const evaluations: FixtureBenchmarkEvaluation[] = [];
      for (let i = 0; i < BENCHMARK_NOTICE_FIXTURES.length; i += 1) {
        const fixture = BENCHMARK_NOTICE_FIXTURES[i]!;
        setBenchmarkProgressLabel(
          `Running ${i + 1}/${BENCHMARK_NOTICE_FIXTURES.length}: ${fixture.id}`
        );
        const callRecord = await runOnDeviceNoticeExtraction(fixture.rawText);
        const evaluation = evaluateExtraction(fixture, callRecord.output, {
          latencyMs: callRecord.latencyMs,
          inferenceSource: callRecord.inferenceSource,
        });
        evaluations.push(evaluation);
      }
      setBenchmarkSummary(summarizeBenchmarkSuite(evaluations));
    } catch (err) {
      setBenchmarkError(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      );
    } finally {
      setBenchmarkRunning(false);
      setBenchmarkProgressLabel(null);
    }
  };

  const allowlistPrecheckPassed = (() => {
    try {
      validateCloudBoundPayload(M0_SMOKE_TEST_CLOUD_PAYLOAD);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <main
      style={{
        maxWidth: "1080px",
        margin: "0 auto",
        padding: "1.5rem",
        fontFamily:
          'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: "#0f172a",
        lineHeight: 1.5,
      }}
    >
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ margin: "0 0 0.35rem", fontSize: "1.6rem" }}>
          NoticeLens — Milestone 0 Hybrid AI Logic Feasibility Gate
        </h1>
        <p style={{ margin: 0, color: "#475569", fontSize: "0.95rem" }}>
          Unsimulated Firebase AI Logic (<code>firebase/ai</code>,{" "}
          <code>GoogleAIBackend</code>) diagnostic harness. Input scope: pasted
          plain text and <code>.txt</code> files only (image/PDF inputs
          deferred). Badges reflect runtime{" "}
          <code>result.response.inferenceSource</code> only.
        </p>
      </header>

      <section
        aria-label="Environment and Chrome readiness"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "1rem",
            background: "#f8fafc",
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>
            1. Firebase &amp; App Check (.env.local) Readiness
          </h2>
          <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.9rem" }}>
            <li data-testid="firebase-core-status">
              Core Firebase Web Config:{" "}
              <strong>
                {envDiag.isCoreFirebaseConfigured
                  ? "Configured"
                  : `Missing (${envDiag.missingCoreFirebaseKeys.join(", ")})`}
              </strong>
            </li>
            <li data-testid="firebase-appcheck-status">
              App Check Site Key:{" "}
              <strong>
                {envDiag.hasAppCheckSiteKey
                  ? "Configured"
                  : "Missing (VITE_FIREBASE_APPCHECK_SITE_KEY)"}
              </strong>
            </li>
            {import.meta.env.DEV ? (
              <li>
                Localhost App Check Debug Mode:{" "}
                <strong>
                  {envDiag.hasDevDebugTokenOverride
                    ? "Explicit debug token in .env.local"
                    : "Dev auto-mint enabled"}
                </strong>
              </li>
            ) : null}
            <li>
              Configured Cloud Model:{" "}
              <code>{envDiag.cloudModelName}</code>
            </li>
          </ul>
        </div>

        <div
          style={{
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            padding: "1rem",
            background: "#f8fafc",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1.05rem" }}>
              2. Chrome Gemini Nano Diagnostic (Read-Only)
            </h2>
            <button
              type="button"
              data-testid="btn-refresh-capability"
              onClick={() => void refreshChromeCapability()}
              style={{
                padding: "0.25rem 0.6rem",
                fontSize: "0.8rem",
                cursor: "pointer",
              }}
            >
              Re-probe
            </button>
          </div>
          {chromeReport ? (
            <ul
              style={{
                margin: "0.6rem 0 0",
                paddingLeft: "1.2rem",
                fontSize: "0.9rem",
              }}
            >
              <li>
                <code>self.LanguageModel</code>:{" "}
                <strong data-testid="chrome-lm-global">
                  {chromeReport.hasLanguageModelGlobal ? "Present" : "Missing"}
                </strong>
              </li>
              <li>
                <code>LanguageModel.availability(en)</code>:{" "}
                <code data-testid="chrome-lm-availability">
                  {chromeReport.availability}
                </code>
              </li>
              <li>
                Browser network state (<code>navigator.onLine</code>):{" "}
                <strong data-testid="chrome-online-state">
                  {chromeReport.isOnline ? "online" : "offline"}
                </strong>
              </li>
              {chromeReport.errorDetail ? (
                <li style={{ color: "#b45309" }}>{chromeReport.errorDetail}</li>
              ) : null}
            </ul>
          ) : (
            <p style={{ margin: "0.6rem 0 0", fontSize: "0.9rem" }}>
              Probing Chrome LanguageModel availability...
            </p>
          )}
        </div>
      </section>

      <section
        aria-label="Plain text notice input and ONLY_ON_DEVICE test"
        style={{
          border: "1px solid #cbd5e1",
          borderRadius: "8px",
          padding: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>
          Step A — Test Real <code>ONLY_ON_DEVICE</code> Structured Extraction
        </h2>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "1rem",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <label style={{ fontSize: "0.9rem" }}>
            Synthetic fixture:{" "}
            <select
              data-testid="select-fixture"
              value={selectedFixtureId}
              onChange={handleSelectFixture}
              style={{ padding: "0.3rem" }}
            >
              {BENCHMARK_NOTICE_FIXTURES.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
              {selectedFixtureId === "custom-txt" ? (
                <option value="custom-txt">Uploaded .txt notice</option>
              ) : null}
            </select>
          </label>

          <label style={{ fontSize: "0.9rem" }}>
            Or load plain <code>.txt</code>:{" "}
            <input
              data-testid="input-txt-upload"
              type="file"
              accept=".txt,text/plain"
              onChange={(e) => void handleTxtFileUpload(e)}
            />
          </label>
        </div>

        {inputWarning ? (
          <p
            role="alert"
            data-testid="input-scope-warning"
            style={{
              background: "#fef3c7",
              border: "1px solid #d97706",
              padding: "0.5rem 0.75rem",
              borderRadius: "6px",
              color: "#78350f",
              fontSize: "0.9rem",
            }}
          >
            {inputWarning}
          </p>
        ) : null}

        <textarea
          aria-label="Plain text notice input"
          data-testid="textarea-notice"
          value={noticeText}
          onChange={(e) => setNoticeText(e.target.value)}
          rows={9}
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            padding: "0.65rem",
            marginBottom: "0.75rem",
          }}
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <button
            type="button"
            data-testid="btn-run-on-device"
            disabled={onDeviceRunning || benchmarkRunning}
            onClick={() => void handleRunOnDevice()}
            style={{
              padding: "0.55rem 1rem",
              fontWeight: 700,
              background: "#15803d",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            {onDeviceRunning
              ? "Running ONLY_ON_DEVICE..."
              : "1. Run Real ONLY_ON_DEVICE Inference"}
          </button>

          <button
            type="button"
            data-testid="btn-run-benchmark"
            disabled={onDeviceRunning || benchmarkRunning}
            onClick={() => void handleRunFiveFixtureBenchmark()}
            style={{
              padding: "0.55rem 1rem",
              fontWeight: 600,
              background: "#0f172a",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            {benchmarkRunning
              ? benchmarkProgressLabel ?? "Running 5-Fixture Benchmark..."
              : "Run 5-Fixture ONLY_ON_DEVICE Benchmark"}
          </button>
        </div>

        {downloadProgressPct !== null && onDeviceRunning ? (
          <p style={{ fontSize: "0.88rem", marginTop: "0.6rem" }}>
            Device model download/load progress:{" "}
            <strong>{downloadProgressPct}%</strong>
          </p>
        ) : null}

        {onDeviceError ? (
          <div
            role="alert"
            data-testid="on-device-error"
            style={{
              marginTop: "0.85rem",
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid #dc2626",
              background: "#fef2f2",
              color: "#991b1b",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          >
            {onDeviceError}
          </div>
        ) : null}

        {onDeviceResult ? (
          <div
            data-testid="on-device-result"
            style={{
              marginTop: "1rem",
              padding: "0.85rem",
              border: "1px solid #86efac",
              borderRadius: "6px",
              background: "#f0fdf4",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                alignItems: "center",
                marginBottom: "0.6rem",
              }}
            >
              <InferenceBadge
                actualInferenceSource={onDeviceResult.inferenceSource}
                contextLabel="on-device"
              />
              <span style={{ fontSize: "0.88rem" }}>
                Latency:{" "}
                <strong data-testid="on-device-latency">
                  {onDeviceResult.latencyMs} ms
                </strong>
              </span>
              <span style={{ fontSize: "0.88rem" }}>
                Network at call:{" "}
                <strong data-testid="on-device-network-state">
                  {onDeviceResult.onlineAtExecution ? "online" : "offline"}
                </strong>
              </span>
            </div>

            <div style={{ fontSize: "0.9rem", marginBottom: "0.6rem" }}>
              <strong>Amount:</strong> £
              {onDeviceResult.verifiedExtraction.amountGBP} |{" "}
              <strong>Deadline:</strong>{" "}
              {onDeviceResult.verifiedExtraction.responseDeadline} |{" "}
              <strong>Period:</strong>{" "}
              {onDeviceResult.verifiedExtraction.billingPeriod}
            </div>

            <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.88rem" }}>
              {onDeviceResult.verifiedExtraction.obligations.map((ob, idx) => (
                <li key={idx} style={{ marginBottom: "0.4rem" }}>
                  <strong>{ob.action}</strong>{" "}
                  {ob.dueDate ? `(Due: ${ob.dueDate})` : ""} —{" "}
                  <code>&ldquo;{ob.sourceQuote}&rdquo;</code>{" "}
                  <strong
                    style={{
                      color: ob.verification.verified ? "#15803d" : "#b45309",
                    }}
                  >
                    [
                    {ob.verification.verified
                      ? `VERIFIED (${ob.verification.matchMode} @ ${ob.verification.startOffset}..${ob.verification.endOffset})`
                      : "UNVERIFIED QUOTE"}
                    ]
                  </strong>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {benchmarkError ? (
          <div
            role="alert"
            data-testid="benchmark-error"
            style={{
              marginTop: "0.85rem",
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid #dc2626",
              background: "#fef2f2",
              color: "#991b1b",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          >
            {benchmarkError}
          </div>
        ) : null}

        {benchmarkSummary ? (
          <div
            data-testid="benchmark-summary"
            style={{ marginTop: "1rem", overflowX: "auto" }}
          >
            <h3 style={{ margin: "0 0 0.4rem", fontSize: "1rem" }}>
              5-Fixture Benchmark Summary — Mean Accuracy:{" "}
              {benchmarkSummary.meanFieldAccuracyPct}% | Quote Verification:{" "}
              {benchmarkSummary.meanQuoteVerificationRatePct}% | Median Latency:{" "}
              {benchmarkSummary.medianLatencyMs} ms (Mean:{" "}
              {benchmarkSummary.meanLatencyMs} ms)
            </h3>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.84rem",
              }}
            >
              <thead>
                <tr style={{ background: "#e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "0.4rem" }}>Fixture</th>
                  <th style={{ padding: "0.4rem" }}>Source</th>
                  <th style={{ padding: "0.4rem" }}>Amount</th>
                  <th style={{ padding: "0.4rem" }}>Deadline</th>
                  <th style={{ padding: "0.4rem" }}>Period</th>
                  <th style={{ padding: "0.4rem" }}>Verified Quotes</th>
                  <th style={{ padding: "0.4rem" }}>Score</th>
                  <th style={{ padding: "0.4rem" }}>Latency</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkSummary.results.map((r) => (
                  <tr
                    key={r.fixtureId}
                    style={{ borderBottom: "1px solid #cbd5e1" }}
                  >
                    <td style={{ padding: "0.4rem" }}>
                      <code>{r.fixtureId}</code>
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      <code>{String(r.inferenceSource)}</code>
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {r.amountExact ? "PASS" : "FAIL"}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {r.deadlineMatch ? "PASS" : "FAIL"}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {r.billingPeriodMatch ? "PASS" : "FAIL"}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {r.verifiedQuotesCount}/{r.totalQuotesCount}
                    </td>
                    <td style={{ padding: "0.4rem" }}>
                      {r.overallFieldAccuracyPct}%
                    </td>
                    <td style={{ padding: "0.4rem" }}>{r.latencyMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section
        aria-label="Allowlisted ONLY_IN_CLOUD test"
        style={{
          border: "1px solid #cbd5e1",
          borderRadius: "8px",
          padding: "1rem",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>
          Step B — Test Real <code>ONLY_IN_CLOUD</code> Call on Allowlisted
          Redacted Brief
        </h2>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
          Strict runtime allowlist pre-check (
          <code>validateCloudBoundPayload</code>):{" "}
          <strong data-testid="allowlist-precheck">
            {allowlistPrecheckPassed ? "PASSED (0 PII / closed keys)" : "FAILED"}
          </strong>
        </p>

        <pre
          data-testid="cloud-payload-preview"
          style={{
            background: "#0f172a",
            color: "#e2e8f0",
            padding: "0.75rem",
            borderRadius: "6px",
            fontSize: "0.8rem",
            overflowX: "auto",
            marginBottom: "0.75rem",
          }}
        >
          {JSON.stringify(M0_SMOKE_TEST_CLOUD_PAYLOAD, null, 2)}
        </pre>

        <button
          type="button"
          data-testid="btn-run-in-cloud"
          disabled={cloudRunning}
          onClick={() => void handleRunInCloud()}
          style={{
            padding: "0.55rem 1rem",
            fontWeight: 700,
            background: "#1d4ed8",
            color: "#ffffff",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          {cloudRunning
            ? "Running ONLY_IN_CLOUD..."
            : "2. Run Real ONLY_IN_CLOUD Inference"}
        </button>

        {cloudError ? (
          <div
            role="alert"
            data-testid="cloud-error"
            style={{
              marginTop: "0.85rem",
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid #dc2626",
              background: "#fef2f2",
              color: "#991b1b",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          >
            {cloudError}
          </div>
        ) : null}

        {cloudResult ? (
          <div
            data-testid="cloud-result"
            style={{
              marginTop: "1rem",
              padding: "0.85rem",
              border: "1px solid #93c5fd",
              borderRadius: "6px",
              background: "#eff6ff",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                alignItems: "center",
                marginBottom: "0.6rem",
              }}
            >
              <InferenceBadge
                actualInferenceSource={cloudResult.inferenceSource}
                contextLabel="in-cloud"
              />
              <span style={{ fontSize: "0.88rem" }}>
                Model: <code>{cloudResult.modelName}</code>
              </span>
              <span style={{ fontSize: "0.88rem" }}>
                Latency:{" "}
                <strong data-testid="cloud-latency">
                  {cloudResult.latencyMs} ms
                </strong>
              </span>
            </div>

            <p style={{ fontSize: "0.9rem", margin: "0 0 0.5rem" }}>
              {cloudResult.output.summaryPlainEnglish}
            </p>
            <pre
              style={{
                background: "#ffffff",
                border: "1px solid #bfdbfe",
                padding: "0.65rem",
                borderRadius: "6px",
                fontSize: "0.82rem",
                whiteSpace: "pre-wrap",
                margin: 0,
              }}
            >
              {cloudResult.output.replyTemplateWithPlaceholders}
            </pre>
          </div>
        ) : null}
      </section>
    </main>
  );
}
