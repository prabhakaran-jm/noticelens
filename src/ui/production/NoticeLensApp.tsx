import { useEffect, useMemo, useRef, useState } from "react";
import originalSample from "../../../examples/energy-backbill-original.txt?raw";
import revisedSample from "../../../examples/energy-backbill-revised.txt?raw";
import { runOnDeviceNoticeExtraction } from "../../ai/onDeviceExtractor";
import { probeChromeLanguageModelAvailability, type ChromeCapabilityReport } from "../../ai/capability";
import { buildClosedCloudInspection } from "../../adapters/closedCloudInspection";
import {
  CLOUD_SUBMISSION_BLOCKED_REASON,
  createCloudApprovalSession,
} from "../../adapters/cloudApprovalSession";
import { identifierContextKey } from "../../adapters/privacyApproval";
import {
  approvalBindingsEqual,
  approvePending,
  invalidateActiveApprovals,
  isHandleApproved,
  registerApprovablePayload,
  releaseInvalidatedApprovals,
  revokeApproval,
  type ApprovalBinding,
  type ApprovalHandle,
} from "../../domain/approvalRegistry";
import { groundNoticeFacts } from "../../adapters/groundNoticeFacts";
import {
  compareNotices,
  extractComparableFacts,
  maskUnsettledComparison,
} from "../../domain/compareNotices";
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
import type { PrivacyApprovalView } from "../../adapters/privacyApproval";
import { receiptForOnDeviceCall } from "./onDeviceSession";

let sessionCounter = 0;

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
  const [activeHandle, setActiveHandle] = useState<ApprovalHandle | null>(null);
  const [editGeneration, setEditGeneration] = useState(0);
  const [extractionGeneration, setExtractionGeneration] = useState(0);
  const [documentEpoch, setDocumentEpoch] = useState(0);
  const [sessionNonce] = useState(() => {
    sessionCounter += 1;
    return `sess-${sessionCounter}`;
  });
  const noticeTextRef = useRef(originalText);
  const generationRef = useRef(0);
  const requestIdRef = useRef(0);
  const liveBindingRef = useRef<ApprovalBinding | null>(null);
  const dropApproval = () => {
    invalidateActiveApprovals();
    setActiveHandle(null);
  };
  const bumpGeneration = () => {
    generationRef.current += 1;
    setEditGeneration(generationRef.current);
  };
  const replaceNoticeText = (text: string) => {
    dropApproval();
    noticeTextRef.current = normalizeNewlines(text);
    setOriginalText(noticeTextRef.current);
    setExtraction(null);
    setExtractionGeneration((current) => current + 1);
    setReceipts([]);
    setDeviceMessage(null);
    bumpGeneration();
  };

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

  const [settledText, setSettledText] = useState(originalText);
  useEffect(() => {
    if (originalText === settledText) {
      return;
    }
    // A goal, checkbox, or on-device result bumps the approval generation
    // without changing the notice text. That must not abandon this timer.
    // A later text edit clears it through the effect cleanup.
    const handle = window.setTimeout(() => {
      setSettledText(noticeTextRef.current);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [originalText, settledText]);
  const grounded = useMemo(
    () =>
      groundNoticeFacts({
        rawNoticeText: originalText,
        extraction,
        today,
      }),
    [originalText, extraction, today]
  );
  const inspection = useMemo(() => {
    if (settledText !== originalText) {
      return buildClosedCloudInspection({
        rawNoticeText: settledText,
        view: grounded,
        responseGoal,
        circumstanceFlags: flags,
        extraKnownIdentifiers: [],
      });
    }
    return buildClosedCloudInspection({
      rawNoticeText: originalText,
      view: grounded,
      responseGoal,
      circumstanceFlags: flags,
      extraKnownIdentifiers: [],
    });
  }, [settledText, originalText, grounded, responseGoal, flags]);
  const identifierKey = identifierContextKey(inspection.guardOptions);
  const [identifierEpoch, setIdentifierEpoch] = useState(1);
  const [trackedIdentifierKey, setTrackedIdentifierKey] = useState(identifierKey);
  const identifierChanging = trackedIdentifierKey !== identifierKey;
  if (identifierChanging) {
    setTrackedIdentifierKey(identifierKey);
    setIdentifierEpoch((epoch) => epoch + 1);
  }
  const seenIdentifierKey = useRef<string | null>(null);
  useEffect(() => {
    if (seenIdentifierKey.current === null) {
      seenIdentifierKey.current = trackedIdentifierKey;
      return;
    }
    if (seenIdentifierKey.current !== trackedIdentifierKey) {
      seenIdentifierKey.current = trackedIdentifierKey;
      invalidateActiveApprovals();
      setActiveHandle(null);
    }
  }, [trackedIdentifierKey]);
  const inspectionSettled = settledText === originalText && inspection.exactSerialized !== null;
  const approvalBinding: ApprovalBinding | null = inspectionSettled
    ? {
        schema: "noticelens.cloud-brief.v2",
        canonicalBytes: inspection.exactSerialized as string,
        noticeGeneration: editGeneration,
        identifierContextId: `ie-${identifierEpoch}`,
        responseGoal,
        circumstanceFlags: flags,
        extractionGeneration,
        documentContextId: `${sessionNonce}-doc-${documentEpoch}`,
      }
    : null;
  liveBindingRef.current = approvalBinding;
  const privacy = useMemo<PrivacyApprovalView>(() => {
    const approved =
      !identifierChanging &&
      approvalBinding !== null &&
      activeHandle !== null &&
      isHandleApproved(activeHandle, approvalBinding);
    return {
      serialized: inspection.exactSerialized,
      limitations: inspection.limitations,
      approval: null,
      matchesCurrentPayload: approved,
      cloudSendEnabled: false,
      blockedReason: CLOUD_SUBMISSION_BLOCKED_REASON,
    };
  }, [activeHandle, approvalBinding, identifierChanging, inspection.exactSerialized, inspection.limitations]);
  const session = useMemo(
    () =>
      createCloudApprovalSession({
        canonical: null,
        violations: inspection.violations,
      }),
    [inspection]
  );
  const actionLabels = inspection.readableRows
    .filter((row) => row.label.startsWith("Action label"))
    .map((row) => row.value);
  const [settledOriginal, setSettledOriginal] = useState(originalText);
  const [settledRevised, setSettledRevised] = useState(revisedText);
  const originalLiveRef = useRef(originalText);
  const revisedLiveRef = useRef(revisedText);
  originalLiveRef.current = originalText;
  revisedLiveRef.current = revisedText;
  useEffect(() => {
    if (originalText === settledOriginal && revisedText === settledRevised) {
      return;
    }
    const originalSnapshot = originalText;
    const revisedSnapshot = revisedText;
    const handle = window.setTimeout(() => {
      if (originalLiveRef.current !== originalSnapshot || revisedLiveRef.current !== revisedSnapshot) {
        return;
      }
      setSettledOriginal(originalSnapshot);
      setSettledRevised(revisedSnapshot);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [originalText, revisedText, settledOriginal, settledRevised]);
  const originalFacts = useMemo(() => extractComparableFacts(settledOriginal), [settledOriginal]);
  const revisedFacts = useMemo(() => extractComparableFacts(settledRevised), [settledRevised]);
  const settledComparison = useMemo(
    () => compareNotices(originalFacts, revisedFacts, { today }),
    [originalFacts, revisedFacts, today]
  );
  const comparison = maskUnsettledComparison(settledComparison, {
    original: originalText !== settledOriginal,
    revised: revisedText !== settledRevised,
  });
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
            onText={replaceNoticeText}
            onLoadSample={() => replaceNoticeText(ORIGINAL_SAMPLE)}
            grounded={grounded}
            capability={capability}
            reading={reading}
            deviceMessage={deviceMessage}
            onReadOnDevice={() => {
              const requestId = requestIdRef.current + 1;
              requestIdRef.current = requestId;
              const noticeSnapshot = noticeTextRef.current;
              const generationAtStart = generationRef.current;
              setReading(true);
              setDeviceMessage(null);
              const stillCurrent = () =>
                requestId === requestIdRef.current &&
                noticeTextRef.current === noticeSnapshot &&
                generationRef.current === generationAtStart;
              void runOnDeviceNoticeExtraction(noticeSnapshot)
                .then((record) => {
                  if (!stillCurrent()) {
                    return;
                  }
                  const receipt = receiptForOnDeviceCall(record);
                  if (!stillCurrent()) {
                    return;
                  }
                  setReceipts((current) => [...current, receipt]);
                  setExtraction(record.output);
                  setExtractionGeneration((current) => current + 1);
                  dropApproval();
                  bumpGeneration();
                })
                .catch((error: unknown) => {
                  if (!stillCurrent()) {
                    return;
                  }
                  setDeviceMessage(
                    error instanceof Error
                      ? error.message
                      : "On-device reading failed before a source was reported."
                  );
                })
                .finally(() => {
                  if (requestId === requestIdRef.current) {
                    setReading(false);
                  }
                });
            }}
          />
        ) : null}
        {step === "plan" ? (
          <ActionPlanScreen
            view={grounded}
            identifiers={identifiers}
            responseGoal={responseGoal}
            onResponseGoal={(goal) => {
              dropApproval();
              setResponseGoal(goal);
              bumpGeneration();
            }}
            flags={flags}
            onFlags={(next) => {
              dropApproval();
              setFlags(next);
              bumpGeneration();
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
            onRevisedText={(text) => {
              dropApproval();
              setDocumentEpoch((current) => current + 1);
              setRevisedText(normalizeNewlines(text));
              bumpGeneration();
            }}
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
          generation={editGeneration}
          identifierContext={`ie-${identifierEpoch}-doc-${documentEpoch}-ex-${extractionGeneration}`}
          actionLabels={actionLabels}
          onClose={() => setPrivacyOpen(false)}
          onApprove={(serialized) => {
            const binding = liveBindingRef.current;
            if (
              binding === null ||
              serialized !== binding.canonicalBytes ||
              generationRef.current !== binding.noticeGeneration
            ) {
              return;
            }
            const registered = registerApprovablePayload(binding);
            if (!registered.ok) {
              return;
            }
            const latest = liveBindingRef.current;
            if (
              latest === null ||
              latest.canonicalBytes !== serialized ||
              latest.noticeGeneration !== binding.noticeGeneration ||
              latest.identifierContextId !== binding.identifierContextId ||
              latest.documentContextId !== binding.documentContextId ||
              latest.extractionGeneration !== binding.extractionGeneration ||
              latest.responseGoal !== binding.responseGoal ||
              !approvalBindingsEqual(latest, binding)
            ) {
              revokeApproval(registered.handle);
              releaseInvalidatedApprovals();
              return;
            }
            if (!approvePending(registered.handle, latest)) {
              revokeApproval(registered.handle);
              releaseInvalidatedApprovals();
              return;
            }
            setActiveHandle(registered.handle);
          }}
        />
      ) : null}
    </>
  );
}
