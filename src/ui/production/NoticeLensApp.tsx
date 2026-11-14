import { useEffect, useMemo, useState } from "react";
import originalSample from "../../../examples/energy-backbill-original.txt?raw";
import revisedSample from "../../../examples/energy-backbill-revised.txt?raw";
import { runOnDeviceNoticeExtraction } from "../../ai/onDeviceExtractor";
import { probeChromeLanguageModelAvailability, type ChromeCapabilityReport } from "../../ai/capability";
import { buildCloudBrief } from "../../adapters/cloudBriefBuilder";
import { createCloudApprovalSession } from "../../adapters/cloudApprovalSession";
import {
  privacyApprovalView,
  recordUserPayloadApproval,
  type UserPayloadApproval,
} from "../../adapters/privacyApproval";
import { briefSourceFromGrounded, groundNoticeFacts } from "../../adapters/groundNoticeFacts";
import { compareNoticeTexts } from "../../domain/compareNotices";
import { isoDateFromClock } from "../../domain/dates";
import type { InferenceEvidenceReceipt } from "../../domain/evidenceReceipt";
import { normalizeNewlines } from "../../domain/textNormalize";
import type { CircumstanceFlag, RawNoticeExtraction, ResponseGoal } from "../../domain/types";
import { HybridStagesStrip } from "../layout/HybridStagesStrip";
import { InferenceEvidenceDrawer } from "../layout/InferenceEvidenceDrawer";
import { LegalScopeFooter } from "../layout/LegalScopeFooter";
import { TopNavHeader, type WorkflowStep } from "../layout/TopNavHeader";
import { ActionPlanScreen } from "../screens/ActionPlanScreen";
import { CompareUpdateScreen } from "../screens/CompareUpdateScreen";
import { PrepareReplyScreen } from "../screens/PrepareReplyScreen";
import { ReadNoticeScreen } from "../screens/ReadNoticeScreen";
import { PrivacyApprovalModal } from "../privacy/PrivacyApprovalModal";
import { receiptForOnDeviceCall } from "./onDeviceSession";

const ORIGINAL_SAMPLE = normalizeNewlines(originalSample);
const REVISED_SAMPLE = normalizeNewlines(revisedSample);

export function NoticeLensApp() {
  const today = useMemo(() => isoDateFromClock(new Date(), "Europe/London"), []);
  const [step, setStep] = useState<WorkflowStep>("read");
  const [originalText, setOriginalText] = useState(ORIGINAL_SAMPLE);
  const [revisedText, setRevisedText] = useState(REVISED_SAMPLE);
  const [extraction, setExtraction] = useState<RawNoticeExtraction | null>(null);
  const [capability, setCapability] = useState<ChromeCapabilityReport | null>(null);
  const [receipts, setReceipts] = useState<InferenceEvidenceReceipt[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [responseGoal, setResponseGoal] = useState<ResponseGoal>("request_billing_review");
  const [flags, setFlags] = useState<CircumstanceFlag[]>([]);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [userApproval, setUserApproval] = useState<UserPayloadApproval | null>(null);
  const [editGeneration, setEditGeneration] = useState(0);
  const invalidateApproval = () => setEditGeneration((current) => current + 1);

  useEffect(() => {
    let cancelled = false;
    void probeChromeLanguageModelAvailability().then((report) => {
      if (!cancelled) {
        setCapability(report);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const grounded = useMemo(
    () =>
      groundNoticeFacts({
        rawNoticeText: originalText,
        extraction,
        today,
      }),
    [originalText, extraction, today]
  );
  const inspection = useMemo(
    () =>
      buildCloudBrief({
        rawNoticeText: originalText,
        source: briefSourceFromGrounded(grounded),
        edits: {
          responseGoal,
          circumstanceFlags: flags,
          extraKnownIdentifiers: [],
        },
      }),
    [originalText, grounded, responseGoal, flags]
  );
  const privacy = useMemo(
    () =>
      privacyApprovalView({
        serialized: inspection.exactSerialized,
        limitations: inspection.limitations,
        approval: userApproval,
        generation: editGeneration,
      }),
    [inspection, userApproval, editGeneration]
  );
  const session = useMemo(
    () =>
      createCloudApprovalSession({
        canonical: inspection.canonical,
        violations: inspection.violations,
      }),
    [inspection]
  );
  const comparison = useMemo(
    () => compareNoticeTexts(originalText, revisedText, { today }),
    [originalText, revisedText, today]
  );
  const identifiers = inspection.redaction.ok ? inspection.redaction.localIdentifierMap.entries : [];

  return (
    <>
      <div className="sr-only" aria-live="polite">
        {step === "read"
          ? "Read notice"
          : step === "plan"
            ? "Action plan"
            : step === "reply"
              ? "Prepare reply"
              : "Compare update"}
      </div>
      <TopNavHeader
        step={step}
        onStep={setStep}
        capability={capability}
        onOpenEvidence={() => setDrawerOpen(true)}
      />
      <main className="app-main">
        <HybridStagesStrip step={step} />
        {step === "read" ? (
          <ReadNoticeScreen
            text={originalText}
            onText={(text) => {
              setOriginalText(normalizeNewlines(text));
              setExtraction(null);
              setReceipts([]);
              setDeviceMessage(null);
              invalidateApproval();
            }}
            onLoadSample={() => {
              setOriginalText(ORIGINAL_SAMPLE);
              setExtraction(null);
              setReceipts([]);
              setDeviceMessage(null);
              invalidateApproval();
            }}
            grounded={grounded}
            capability={capability}
            reading={reading}
            deviceMessage={deviceMessage}
            onReadOnDevice={() => {
              setReading(true);
              setDeviceMessage(null);
              void runOnDeviceNoticeExtraction(originalText)
                .then((record) => {
                  const receipt = receiptForOnDeviceCall(record);
                  setReceipts((current) => [...current, receipt]);
                  setExtraction(record.output);
                  invalidateApproval();
                })
                .catch((error: unknown) => {
                  setDeviceMessage(
                    error instanceof Error
                      ? error.message
                      : "On-device reading failed before a source was reported."
                  );
                })
                .finally(() => setReading(false));
            }}
          />
        ) : null}
        {step === "plan" ? (
          <ActionPlanScreen
            view={grounded}
            identifiers={identifiers}
            responseGoal={responseGoal}
            onResponseGoal={(goal) => {
              setResponseGoal(goal);
              invalidateApproval();
            }}
            flags={flags}
            onFlags={(next) => {
              setFlags(next);
              invalidateApproval();
            }}
          />
        ) : null}
        {step === "reply" ? (
          <PrepareReplyScreen
            inspection={inspection}
            session={session}
            privacyApproved={privacy.matchesCurrentPayload}
            onReviewPrivacy={() => setPrivacyOpen(true)}
          />
        ) : null}
        {step === "compare" ? (
          <CompareUpdateScreen
            originalText={originalText}
            revisedText={revisedText}
            onRevisedText={(text) => setRevisedText(normalizeNewlines(text))}
            comparison={comparison}
          />
        ) : null}
      </main>
      <LegalScopeFooter />
      <InferenceEvidenceDrawer
        open={drawerOpen}
        receipts={receipts}
        onClose={() => setDrawerOpen(false)}
      />
      {privacyOpen ? (
        <PrivacyApprovalModal
          open
          view={privacy}
          onClose={() => setPrivacyOpen(false)}
          onApprove={(serialized) => {
            if (inspection.exactSerialized === null) {
              return;
            }
            setUserApproval(
              recordUserPayloadApproval(serialized, inspection.exactSerialized, editGeneration)
            );
          }}
        />
      ) : null}
    </>
  );
}
