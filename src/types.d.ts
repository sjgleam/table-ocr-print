export type Lang = "en" | "ko" | "other";

export interface Column {
  header: string;
  lang: Lang;
}

export interface TableData {
  columns: Column[];
  rows: string[][];
}

export type Provider = "paddle" | "openai" | "ollama";

/** Shape persisted to settings.json (all fields optional/partial). */
export interface Settings {
  apiKey?: string;
  provider?: Provider;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  paddlePythonPath?: string;
}

/** Shape returned by get-settings, with defaults already applied. */
export interface ResolvedSettings {
  apiKey: string;
  provider: Provider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  paddlePythonPath: string;
}

export interface SaveSettingsResult {
  ok: boolean;
  error?: string;
}

export interface OllamaReadiness {
  ok: boolean;
  error?: string;
}

export interface ExportPdfResult {
  canceled: boolean;
  filePath?: string;
}

export interface PrintResult {
  success: boolean;
  reason: string;
}

export interface ExtractParams {
  provider?: Provider;
  apiKey?: string;
  dataUrl: string;
  model?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

/** window.api surface exposed by preload.ts to the renderer. */
export interface WindowApi {
  getSettings(): Promise<ResolvedSettings>;
  saveSettings(settings: Settings): Promise<SaveSettingsResult>;
  extractTable(dataUrl: string): Promise<TableData>;
  ensureOllamaReady(baseUrl?: string): Promise<OllamaReadiness>;
  exportPdf(landscape: boolean, suggestedName: string): Promise<ExportPdfResult>;
  printNow(landscape: boolean): Promise<PrintResult>;
}
