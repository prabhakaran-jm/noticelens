const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Development-only opt-in for one real Firebase AI Logic call.
 * Production builds remove this branch. The flag is a Vite environment
 * value, so a URL parameter or localStorage entry cannot turn it on.
 * `CLOUD_SUBMISSION_ENABLED` stays false.
 */
export function isRealCloudDiagnosticEnabled(hostname?: string): boolean {
  if (import.meta.env.DEV !== true) {
    return false;
  }
  if (import.meta.env.VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC !== "1") {
    return false;
  }
  const host = hostname ?? (typeof location === "undefined" ? "" : location.hostname);
  return LOOPBACK_HOSTS.has(host);
}
