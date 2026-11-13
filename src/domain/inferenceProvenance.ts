export class InferenceProvenanceError extends Error {
  constructor() {
    super("Inference provenance did not match the requested mode");
    this.name = "InferenceProvenanceError";
  }
}

/** Fails closed when the runtime source is missing or is not the mode that was requested. */
export function requireInferenceSource(
  actual: string | undefined,
  expected: "on_device" | "in_cloud"
): void {
  if (actual !== expected) {
    throw new InferenceProvenanceError();
  }
}
