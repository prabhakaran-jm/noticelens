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

  const colors =
    resolved.status === "verified_on_device"
      ? { bg: "#dcfce7", border: "#16a34a", fg: "#14532d" }
      : resolved.status === "verified_in_cloud"
        ? { bg: "#dbeafe", border: "#2563eb", fg: "#1e3a8a" }
        : { bg: "#fef3c7", border: "#d97706", fg: "#78350f" };

  return (
    <span
      data-testid={
        contextLabel
          ? `inference-badge-${contextLabel}`
          : "inference-badge"
      }
      data-inference-status={resolved.status}
      data-raw-inference-source={resolved.rawReportedValue}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.2rem 0.6rem",
        borderRadius: "999px",
        border: `1px solid ${colors.border}`,
        backgroundColor: colors.bg,
        color: colors.fg,
        fontFamily: "monospace",
        fontSize: "0.82rem",
        fontWeight: 700,
      }}
    >
      <span>{resolved.badgeText}</span>
      <span style={{ fontWeight: 400, opacity: 0.85 }}>
        (response.inferenceSource: {resolved.rawReportedValue})
      </span>
    </span>
  );
}
