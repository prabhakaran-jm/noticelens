import { InferenceSource } from "firebase/ai";

export interface InferenceBadgeProps {
  actualInferenceSource: string | undefined;
  contextLabel?: string;
}

export function resolveInferenceBadgeState(
  actualInferenceSource: string | undefined
): {
  status: "verified_on_device" | "verified_in_cloud" | "unverified";
  badgeText: string;
  rawReportedValue: string;
} {
  if (actualInferenceSource === InferenceSource.ON_DEVICE) {
    return {
      status: "verified_on_device",
      badgeText: "ON_DEVICE",
      rawReportedValue: actualInferenceSource,
    };
  }
  if (actualInferenceSource === InferenceSource.IN_CLOUD) {
    return {
      status: "verified_in_cloud",
      badgeText: "IN_CLOUD",
      rawReportedValue: actualInferenceSource,
    };
  }
  return {
    status: "unverified",
    badgeText: "NOT_VERIFIED",
    rawReportedValue:
      actualInferenceSource === undefined
        ? "undefined"
        : String(actualInferenceSource),
  };
}

export function InferenceBadge({
  actualInferenceSource,
  contextLabel,
}: InferenceBadgeProps) {
  const resolved = resolveInferenceBadgeState(actualInferenceSource);

  const tone =
    resolved.status === "verified_on_device"
      ? "is-on-device"
      : resolved.status === "verified_in_cloud"
        ? "is-in-cloud"
        : "is-unverified";

  return (
    <span
      data-testid={
        contextLabel
          ? `inference-badge-${contextLabel}`
          : "inference-badge"
      }
      data-inference-status={resolved.status}
      data-raw-inference-source={resolved.rawReportedValue}
      className={`inference-badge ${tone}`}
    >
      <span>{resolved.badgeText}</span>
      <span style={{ fontWeight: 400, opacity: 0.85 }}>
        (response.inferenceSource: {resolved.rawReportedValue})
      </span>
    </span>
  );
}
