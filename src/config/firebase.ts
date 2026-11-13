import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import { getAI, GoogleAIBackend, type AI } from "firebase/ai";

// Default to the high-volume workhorse: gemini-3.8-flash returned HTTP 500
// "high demand" on Gemini Developer API (Spark) during M0 live verification.
export const DEFAULT_CLOUD_GEMINI_MODEL = "gemini-3.5-flash-lite";

const FORBIDDEN_CLOUD_MODELS = new Set([
  "gemini-1.0-pro",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
]);

export interface FirebaseEnvDiagnostics {
  hasApiKey: boolean;
  hasAuthDomain: boolean;
  hasProjectId: boolean;
  hasAppId: boolean;
  hasAppCheckSiteKey: boolean;
  hasDevDebugTokenOverride: boolean;
  cloudModelName: string;
  missingCoreFirebaseKeys: string[];
  missingCloudAppCheckKeys: string[];
  isCoreFirebaseConfigured: boolean;
  isCloudAppCheckConfigured: boolean;
}

export class FirebaseSetupBlockerError extends Error {
  public readonly missingKeys: string[];

  constructor(message: string, missingKeys: string[] = []) {
    super(message);
    this.name = "FirebaseSetupBlockerError";
    this.missingKeys = missingKeys;
  }
}

function cleanStaticEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPublicFirebaseEnv() {
  return {
    apiKey: cleanStaticEnv(import.meta.env.VITE_FIREBASE_API_KEY),
    authDomain: cleanStaticEnv(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: cleanStaticEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID),
    appId: cleanStaticEnv(import.meta.env.VITE_FIREBASE_APP_ID),
    appCheckSiteKey: cleanStaticEnv(
      import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY
    ),
    cloudModel: cleanStaticEnv(import.meta.env.VITE_FIREBASE_CLOUD_MODEL),
  };
}

export function getConfiguredCloudModelName(): string {
  const { cloudModel } = readPublicFirebaseEnv();
  const candidate = cloudModel || DEFAULT_CLOUD_GEMINI_MODEL;
  if (FORBIDDEN_CLOUD_MODELS.has(candidate)) {
    throw new FirebaseSetupBlockerError(
      `Configured cloud model "${candidate}" is retired or deprecated in Nov 2026. Use "gemini-3.5-flash-lite" or "gemini-3.8-flash".`
    );
  }
  return candidate;
}

export function getFirebaseEnvDiagnostics(): FirebaseEnvDiagnostics {
  const env = readPublicFirebaseEnv();

  let hasDevDebugTokenOverride = false;
  if (import.meta.env.DEV) {
    hasDevDebugTokenOverride = Boolean(
      cleanStaticEnv(import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN)
    );
  }

  const missingCoreFirebaseKeys: string[] = [];
  if (!env.apiKey) missingCoreFirebaseKeys.push("VITE_FIREBASE_API_KEY");
  if (!env.authDomain)
    missingCoreFirebaseKeys.push("VITE_FIREBASE_AUTH_DOMAIN");
  if (!env.projectId) missingCoreFirebaseKeys.push("VITE_FIREBASE_PROJECT_ID");
  if (!env.appId) missingCoreFirebaseKeys.push("VITE_FIREBASE_APP_ID");

  const missingCloudAppCheckKeys = [...missingCoreFirebaseKeys];
  if (!env.appCheckSiteKey) {
    missingCloudAppCheckKeys.push("VITE_FIREBASE_APPCHECK_SITE_KEY");
  }

  return {
    hasApiKey: Boolean(env.apiKey),
    hasAuthDomain: Boolean(env.authDomain),
    hasProjectId: Boolean(env.projectId),
    hasAppId: Boolean(env.appId),
    hasAppCheckSiteKey: Boolean(env.appCheckSiteKey),
    hasDevDebugTokenOverride,
    cloudModelName: env.cloudModel || DEFAULT_CLOUD_GEMINI_MODEL,
    missingCoreFirebaseKeys,
    missingCloudAppCheckKeys,
    isCoreFirebaseConfigured: missingCoreFirebaseKeys.length === 0,
    isCloudAppCheckConfigured: missingCloudAppCheckKeys.length === 0,
  };
}

let cachedApp: FirebaseApp | null = null;
let cachedAppCheck: AppCheck | null = null;
let cachedAI: AI | null = null;

function ensureFirebaseAppAndAppCheck(options: {
  requireAppCheck: boolean;
}): { app: FirebaseApp; appCheck: AppCheck | null; ai: AI } {
  const env = readPublicFirebaseEnv();
  const diag = getFirebaseEnvDiagnostics();

  if (!diag.isCoreFirebaseConfigured) {
    throw new FirebaseSetupBlockerError(
      `Firebase Web config is not set in .env.local. Missing: ${diag.missingCoreFirebaseKeys.join(", ")}. Copy .env.example to .env.local and populate your Firebase Web App config.`,
      diag.missingCoreFirebaseKeys
    );
  }

  if (options.requireAppCheck && !diag.isCloudAppCheckConfigured) {
    throw new FirebaseSetupBlockerError(
      `Firebase App Check is mandatory for Firebase AI Logic cloud calls (since Nov 2, 2026). Missing in .env.local: ${diag.missingCloudAppCheckKeys.join(", ")}.`,
      diag.missingCloudAppCheckKeys
    );
  }

  if (!cachedApp) {
    const existing = getApps()[0];
    cachedApp =
      existing ??
      initializeApp({
        apiKey: env.apiKey,
        authDomain: env.authDomain,
        projectId: env.projectId,
        appId: env.appId,
      });
  }

  if (env.appCheckSiteKey && !cachedAppCheck) {
    if (import.meta.env.DEV && typeof self !== "undefined") {
      const debugToken = cleanStaticEnv(
        import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN
      );
      (
        self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }
      ).FIREBASE_APPCHECK_DEBUG_TOKEN =
        debugToken && debugToken !== "true" ? debugToken : true;
    }

    cachedAppCheck = initializeAppCheck(cachedApp, {
      provider: new ReCaptchaEnterpriseProvider(env.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  if (!cachedAI) {
    cachedAI = getAI(cachedApp, {
      backend: new GoogleAIBackend(),
    });
  }

  return { app: cachedApp, appCheck: cachedAppCheck, ai: cachedAI };
}

export function getOnDeviceFirebaseAI(): AI {
  return ensureFirebaseAppAndAppCheck({ requireAppCheck: false }).ai;
}

export function getCloudFirebaseAI(): AI {
  return ensureFirebaseAppAndAppCheck({ requireAppCheck: true }).ai;
}
