const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { extractTableFromImage } = require("./src/vlm");

const SETTINGS_PATH = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2), "utf-8");
}

async function pingOllama(baseUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function trySpawnOllamaServe() {
  return new Promise((resolve) => {
    try {
      const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

// If the configured Ollama server isn't reachable, try to launch it locally
// and wait until it responds before returning. Remote (non-localhost)
// servers can't be auto-started, so those just fail fast with guidance.
async function ensureOllamaReady(baseUrlInput) {
  const baseUrl = baseUrlInput || "http://localhost:11434";
  if (await pingOllama(baseUrl)) return { ok: true };

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(baseUrl);
  if (!isLocal) {
    return {
      ok: false,
      error: `Ollama 서버(${baseUrl})에 연결할 수 없습니다. 원격 서버는 자동으로 실행할 수 없으니 해당 PC에서 Ollama를 직접 실행해주세요.`,
    };
  }

  const spawned = await trySpawnOllamaServe();
  if (!spawned) {
    return {
      ok: false,
      error: "Ollama를 실행하지 못했습니다. Ollama가 설치되어 있고 PATH에 등록되어 있는지 확인해주세요.",
    };
  }

  const timeoutMs = 20000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    if (await pingOllama(baseUrl)) return { ok: true };
  }
  return { ok: false, error: "Ollama 서버가 시간 내에 준비되지 않았습니다. 잠시 후 다시 시도해주세요." };
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The native save dialog in the PDF export flow occludes this window;
      // Chromium's background throttling can then leave the page in a
      // suspended/unpainted state, so printToPDF captures a blank frame
      // once the dialog closes. Disabling it keeps the page rendered live.
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("get-settings", () => {
  const s = loadSettings();
  return {
    apiKey: s.apiKey || "",
    provider: s.provider || "openai",
    ollamaBaseUrl: s.ollamaBaseUrl || "http://localhost:11434",
    ollamaModel: s.ollamaModel || "llama3.2-vision",
  };
});

ipcMain.handle("save-settings", (_event, settings) => {
  try {
    const current = loadSettings();
    saveSettings({ ...current, ...settings });
    console.log("SAVE-SETTINGS OK ->", SETTINGS_PATH());
    return { ok: true };
  } catch (err) {
    console.error("SAVE-SETTINGS ERROR:", err);
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle("ensure-ollama-ready", async (_event, { baseUrl }) => {
  return await ensureOllamaReady(baseUrl);
});

ipcMain.handle("extract-table", async (_event, { dataUrl }) => {
  const settings = loadSettings();
  return await extractTableFromImage({
    provider: settings.provider || "openai",
    apiKey: settings.apiKey,
    dataUrl,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.ollamaModel,
  });
});

ipcMain.handle("export-pdf", async (_event, { landscape, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "PDF로 저장",
    defaultPath: suggestedName || "table.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { canceled: true };

  // The save dialog above occluded the window; bring it back and give
  // Chromium a moment to repaint before snapshotting it to PDF, otherwise
  // printToPDF can capture a blank frame (see backgroundThrottling note).
  mainWindow.focus();
  await new Promise((r) => setTimeout(r, 150));

  const buffer = await mainWindow.webContents.printToPDF({
    landscape: !!landscape,
    pageSize: "A4",
    printBackground: true,
    // Our own CSS already sizes .sheet to exactly 210mm and adds its own
    // margin via @page + padding. marginType:"default" additionally imposes
    // Chromium's own print margins on top of that, shrinking the usable
    // area and clipping the (already full-width) sheet — hence content
    // getting cut off at the edge. "none" leaves margin entirely to our CSS.
    margins: { marginType: "none" },
  });
  fs.writeFileSync(filePath, buffer);
  return { canceled: false, filePath };
});

ipcMain.handle("print-now", async (_event, { landscape }) => {
  return new Promise((resolve) => {
    mainWindow.webContents.print(
      { landscape: !!landscape, printBackground: true, margins: { marginType: "none" } },
      (success, reason) => {
        resolve({ success, reason });
      }
    );
  });
});
