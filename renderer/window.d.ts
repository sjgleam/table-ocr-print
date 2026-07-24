import type { WindowApi } from "../src/types";

// Ambient-only: never emitted to JS. Keeps renderer.ts a plain classic
// script (no import/export in its own source) while still getting proper
// types for `window.api`, the surface preload.ts exposes via contextBridge.
declare global {
  interface Window {
    api: WindowApi;
  }
}

export {};
