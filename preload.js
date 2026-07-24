"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    getSettings: () => electron_1.ipcRenderer.invoke("get-settings"),
    saveSettings: (settings) => electron_1.ipcRenderer.invoke("save-settings", settings),
    extractTable: (dataUrl) => electron_1.ipcRenderer.invoke("extract-table", { dataUrl }),
    ensureOllamaReady: (baseUrl) => electron_1.ipcRenderer.invoke("ensure-ollama-ready", { baseUrl }),
    exportPdf: (landscape, suggestedName) => electron_1.ipcRenderer.invoke("export-pdf", { landscape, suggestedName }),
    printNow: (landscape) => electron_1.ipcRenderer.invoke("print-now", { landscape }),
};
electron_1.contextBridge.exposeInMainWorld("api", api);
