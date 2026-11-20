import { vi } from "vitest";

export function stubCoreFirebaseEnv(): void {
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-key");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "test.firebaseapp.com");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "test-project");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "1:1:web:test");
}

export function clearCoreFirebaseEnv(): void {
  vi.stubEnv("VITE_FIREBASE_API_KEY", "");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "");
}
