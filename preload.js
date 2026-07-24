const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  extractTable: (dataUrl) => ipcRenderer.invoke("extract-table", { dataUrl }),
  ensureOllamaReady: (baseUrl) => ipcRenderer.invoke("ensure-ollama-ready", { baseUrl }),
  exportPdf: (landscape, suggestedName) => ipcRenderer.invoke("export-pdf", { landscape, suggestedName }),
  printNow: (landscape) => ipcRenderer.invoke("print-now", { landscape }),
});
