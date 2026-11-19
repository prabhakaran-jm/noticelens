import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";

vi.stubEnv("VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC", "");

afterEach(() => {
  vi.stubEnv("VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC", "");
});
