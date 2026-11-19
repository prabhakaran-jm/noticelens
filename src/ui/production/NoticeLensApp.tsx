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
  attachDispatchOwner,
  invalidateApprovalsForOwner,
  registerApprovablePayload,
  releaseInvalidatedApprovals,
  revokeApproval,
  type PrivacyReview,
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
import type { CircumstanceFlag, CloudDraftOutput, RawNoticeExtraction, ResponseGoal } from "../../domain/types";
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
import {
  bindLiveCloudDispatch,
  createDispatchOwner,
  liveCloudDraftMessage,
  sendLiveApprovedCloudDraft,
  type LiveCloudDraftResult,
} from "../../adapters/liveCloudDispatch";
import { isRealCloudDiagnosticEnabled } from "../../adapters/realCloudDiagnostic";
import { sourceGenerationId } from "../../adapters/supportedNoticeGate";
import type { LiveCloudPreflightState } from "../../adapters/secureCloudPreflight";

let sessionCounter = 0;

const ORIGINAL_SAMPLE = normalizeNewlines(originalSample);
const REVISED_SAMPLE = normalizeNewlines(revisedSample);

export interface CloudDraftProbe {
  generate: (args: {
    prompt: string;
    signal: AbortSignal;
    modelName: string;
  }) => Promise<{ text: string; inferenceSource: string | undefined }>;
  timeoutMs?: number;
}

export function NoticeLensApp(props?: { cloudDraftProbe?: CloudDraftProbe }) {
  const cloudProbe = import.meta.env.PROD ? undefined : props?.cloudDraftProbe;
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
  const activeHandleRef = useRef<ApprovalHandle | null>(null);
  const responseGoalRef = useRef(responseGoal);
  const flagsRef = useRef(flags);
  const extractionGenerationRef = useRef(0);
  const identifierEpochRef = useRef(1);
  const documentEpochRef = useRef(0);
  const todayRef = useRef(today);
  const readLiveRef = useRef<() => LiveCloudPreflightState | null>(() => null);
  const dispatchOwnerRef = useRef<ReturnType<typeof createDispatchOwner> | null>(null);
  const cloudAbortRef = useRef<AbortController | null>(null);
  const cloudRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const [cloudStatus, setCloudStatus] = useState<"idle" | "sending" | "accepted" | "error">("idle");
  const [cloudDraft, setCloudDraft] = useState<CloudDraftOutput | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudViolations, setCloudViolations] = useState<readonly string[]>([]);
  const [cloudInference, setCloudInference] = useState<string | null>(null);
  const [cloudModelName, setCloudModelName] = useState<string | null>(null);
  const realDiagnostic = import.meta.env.DEV === true && isRealCloudDiagnosticEnabled();
  if (dispatchOwnerRef.current === null) {
    dispatchOwnerRef.current = createDispatchOwner();
  }
  const stopCloudSend = () => {
    const inFlightSend = cloudAbortRef.current !== null;
    cloudRequestRef.current += 1;
    cloudAbortRef.current?.abort();
    cloudAbortRef.current = null;
    setCloudDraft(null);
    setCloudInference(null);
    setCloudModelName(null);
    if (inFlightSend) {
      setCloudStatus("error");
      setCloudError(
        "The notice changed before the cloud result could be accepted. A new privacy approval is required to try again."
      );
      setCloudViolations([]);
    } else {
      setCloudStatus("idle");
      setCloudError(null);
      setCloudViolations([]);
    }
  };
  const dropApproval = () => {
    stopCloudSend();
    activeHandleRef.current = null;
    liveBindingRef.current = null;
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
    extractionGenerationRef.current += 1;
    setExtractionGeneration(extractionGenerationRef.current);
    setReceipts([]);
    setDeviceMessage(null);
    bumpGeneration();
  };

  useEffect(() => {
    const owner = dispatchOwnerRef.current;
    if (owner === null) {
      return;
    }
    const release = bindLiveCloudDispatch(owner, () => readLiveRef.current());
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cloudRequestRef.current += 1;
      cloudAbortRef.current?.abort();
      cloudAbortRef.current = null;
      release();
      invalidateApprovalsForOwner(owner);
    };
  }, []);

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
      activeHandleRef.current = null;
      liveBindingRef.current = null;
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
  activeHandleRef.current = activeHandle;
  responseGoalRef.current = responseGoal;
  flagsRef.current = flags;
  extractionGenerationRef.current = extractionGeneration;
  identifierEpochRef.current = identifierEpoch;
  documentEpochRef.current = documentEpoch;
  todayRef.current = today;
  readLiveRef.current = () => {
    const text = noticeTextRef.current;
    const binding = liveBindingRef.current;
    const handle = activeHandleRef.current;
    return {
      rawNoticeText: text,
      today: todayRef.current,
      presentedSourceGenerationId: sourceGenerationId(text),
      noticeGeneration: generationRef.current,
      extractionGeneration: extractionGenerationRef.current,
      identifierContextId: `ie-${identifierEpochRef.current}`,
      documentContextId: `${sessionNonce}-doc-${documentEpochRef.current}`,
      responseGoal: responseGoalRef.current,
      circumstanceFlags: flagsRef.current.slice(),
      presentedCanonicalBytes: binding === null ? "" : binding.canonicalBytes,
      approvalHandle: handle,
    };
  };
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
  const fixtureEligible = originalText === ORIGINAL_SAMPLE || originalText === REVISED_SAMPLE;
  const cloudPathOpen = cloudProbe !== undefined || realDiagnostic;
  const cloudSendEnabled =
    cloudPathOpen &&
    privacy.matchesCurrentPayload &&
    fixtureEligible &&
    responseGoal === "request_billing_review" &&
    flags.length === 0 &&
    cloudStatus !== "sending";
  const sendCloudDraft = () => {
    if (!cloudPathOpen || cloudAbortRef.current !== null) {
      return;
    }
    const request = cloudRequestRef.current + 1;
    cloudRequestRef.current = request;
    const generationAtSend = generationRef.current;
    const controller = new AbortController();
    cloudAbortRef.current = controller;
    setCloudStatus("sending");
    setCloudDraft(null);
    setCloudError(null);
    setCloudViolations([]);
    setCloudInference(null);
    setCloudModelName(null);
    void sendLiveApprovedCloudDraft(
      cloudProbe
        ? {
            generate: cloudProbe.generate,
            signal: controller.signal,
            timeoutMs: cloudProbe.timeoutMs,
          }
        : { signal: controller.signal }
    ).then((result: LiveCloudDraftResult) => {
      if (cloudAbortRef.current === controller) {
        cloudAbortRef.current = null;
      }
      if (!mountedRef.current || request !== cloudRequestRef.current) {
        return;
      }
      if (generationRef.current !== generationAtSend || result.outcome !== "accepted") {
        setCloudDraft(null);
        setCloudInference(null);
        setCloudModelName(null);
        setCloudStatus("error");
        setCloudError(
          liveCloudDraftMessage(result.outcome === "accepted" ? { outcome: "stale" } : result)
        );
        setCloudViolations(result.outcome === "rejected" ? result.violations ?? [] : []);
        return;
      }
      setCloudDraft(result.draft);
      setCloudInference(result.inferenceSource);
      setCloudModelName(result.modelName);
      setCloudStatus("accepted");
      setCloudError(null);
      setCloudViolations([]);
      setReceipts((current) => [...current, result.evidence]);
    }, () => {
      if (cloudAbortRef.current === controller) {
        cloudAbortRef.current = null;
      }
      if (!mountedRef.current || request !== cloudRequestRef.current) {
        return;
      }
      setCloudDraft(null);
      setCloudInference(null);
      setCloudModelName(null);
      setCloudStatus("error");
      setCloudError("Cloud drafting was rejected. A new privacy approval is required to try again.");
      setCloudViolations([]);
    });
  };

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
                  extractionGenerationRef.current += 1;
                  setExtractionGeneration(extractionGenerationRef.current);
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
              responseGoalRef.current = goal;
              dropApproval();
              setResponseGoal(goal);
              bumpGeneration();
            }}
            flags={flags}
            onFlags={(next) => {
              flagsRef.current = next;
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
            cloudDemo={
              cloudPathOpen
                ? {
                    sendEnabled: cloudSendEnabled,
                    status: cloudStatus,
                    message: cloudError,
                    violations: cloudViolations,
                    draft: cloudStatus === "accepted" ? cloudDraft : null,
                    inferenceLabel: cloudInference,
                    modelName: cloudModelName,
                    diagnostic: realDiagnostic && cloudProbe === undefined,
                    onSend: sendCloudDraft,
                  }
                : undefined
            }
          />
        ) : null}
        {step === "compare" ? (
          <CompareUpdateScreen
            originalText={originalText}
            revisedText={revisedText}
            onRevisedText={(text) => {
              dropApproval();
              documentEpochRef.current += 1;
              setDocumentEpoch(documentEpochRef.current);
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
          onApprove={(serialized, review: PrivacyReview) => {
            const binding = liveBindingRef.current;
            const owner = dispatchOwnerRef.current;
            if (
              binding === null ||
              owner === null ||
              serialized !== binding.canonicalBytes ||
              generationRef.current !== binding.noticeGeneration
            ) {
              return;
            }
            const registered = registerApprovablePayload(binding, review);
            if (!registered.ok) {
              return;
            }
            attachDispatchOwner(registered.handle, owner);
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
            if (!approvePending(registered.handle, latest, review)) {
              revokeApproval(registered.handle);
              releaseInvalidatedApprovals();
              return;
            }
            activeHandleRef.current = registered.handle;
            setActiveHandle(registered.handle);
          }}
        />
      ) : null}
    </>
  );
}
