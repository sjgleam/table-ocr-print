"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTableWithPaddle = extractTableWithPaddle;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// Compiled to src/paddle.js, so the script lives one level up.
const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "paddle_table.py");
// First run downloads PP-Structure models, which can take several minutes.
const TIMEOUT_MS = 10 * 60 * 1000;
const HEADER_WORD_RE = /^\s*(순번|번호|no\.?|number|영어|english|word|단어|한글|한국어|korean|뜻|의미|meaning)\s*$/i;
const BARE_NUMBER_RE = /^\s*\d+\s*\.?\s*$/;
function decodeDataUrl(dataUrl) {
    const match = /^data:image\/(\w+);base64,/.exec(dataUrl);
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    const ext = match ? (match[1] === "jpeg" ? "jpg" : match[1]) : "png";
    return { buffer: Buffer.from(base64, "base64"), ext };
}
function runPaddleScript(pythonPath, imagePath) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = (0, child_process_1.spawn)(pythonPath, [SCRIPT_PATH, imagePath], { windowsHide: true });
        }
        catch (err) {
            reject(err);
            return;
        }
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("PaddleOCR 처리가 10분 안에 끝나지 않아 중단했습니다. 최초 실행이라면 모델 다운로드 때문일 수 있으니 잠시 후 다시 시도해주세요."));
        }, TIMEOUT_MS);
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.once("error", (err) => {
            clearTimeout(timer);
            reject(err.code === "ENOENT"
                ? new Error(`Python 실행 파일(${pythonPath})을 찾을 수 없습니다. Python이 설치되어 있는지 확인하거나, 설정에서 Python 경로를 지정해주세요.`)
                : err);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            if (stdout.trim()) {
                resolve(stdout);
            }
            else {
                reject(new Error(`PaddleOCR 스크립트가 응답 없이 종료되었습니다 (exit ${code}).` +
                    (stderr.trim() ? ` ${stderr.trim().slice(-400)}` : "")));
            }
        });
    });
}
// The script guarantees its result is the LAST stdout line starting with "{"
// (PaddleOCR's own logs may precede it).
function parseScriptOutput(stdout) {
    const line = stdout
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.trim().startsWith("{"));
    if (!line) {
        throw new Error("PaddleOCR 스크립트 출력에서 결과 JSON을 찾지 못했습니다.");
    }
    try {
        return JSON.parse(line.trim());
    }
    catch {
        throw new Error("PaddleOCR 스크립트 출력을 JSON으로 해석하지 못했습니다.");
    }
}
// PaddleOCR only returns raw text, so unlike the VLM path the column language
// has to be classified here: dominant Hangul vs Latin letter count, with
// letter-free columns (item numbers etc.) falling back to "other".
function classifyLang(values) {
    const text = values.join("");
    const ko = (text.match(/[가-힣ㄱ-ㆎ]/g) || []).length;
    const en = (text.match(/[A-Za-z]/g) || []).length;
    if (ko === 0 && en === 0)
        return "other";
    return ko >= en ? "ko" : "en";
}
// The OCR grid includes the header row only if the photographed table has
// one, so detect it instead of assuming: either a cell matches a known
// header word, or the first column is numeric in the data rows but not in
// row 0 (the "순번" pattern). When unsure, keep row 0 as data — losing a
// header label is cheaper than losing a word row.
function looksLikeHeaderRow(rows) {
    if (rows.length < 2)
        return false;
    if (rows[0].some((cell) => HEADER_WORD_RE.test(cell)))
        return true;
    const dataFirstCells = rows.slice(1).map((r) => r[0] ?? "");
    const numericCount = dataFirstCells.filter((c) => BARE_NUMBER_RE.test(c)).length;
    return !BARE_NUMBER_RE.test(rows[0][0] ?? "") && numericCount >= dataFirstCells.length * 0.8;
}
async function extractTableWithPaddle({ dataUrl, pythonPath, }) {
    const python = (pythonPath || "").trim() || "python";
    const { buffer, ext } = decodeDataUrl(dataUrl);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paddle-table-"));
    const imagePath = path.join(tmpDir, `input.${ext}`);
    try {
        fs.writeFileSync(imagePath, buffer);
        const parsed = parseScriptOutput(await runPaddleScript(python, imagePath));
        if (parsed.error) {
            throw new Error(`PaddleOCR 오류: ${parsed.error}`);
        }
        const rawCells = parsed.cells;
        if (!Array.isArray(rawCells) || !rawCells.length || !rawCells.every(Array.isArray)) {
            throw new Error("PaddleOCR 응답 형식이 예상과 다릅니다 (cells 누락).");
        }
        const cells = rawCells.map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
        const width = Math.max(...cells.map((r) => r.length));
        const hasHeader = looksLikeHeaderRow(cells);
        const headerRow = hasHeader ? cells[0] : null;
        const dataRows = hasHeader ? cells.slice(1) : cells;
        if (!dataRows.length) {
            throw new Error("PaddleOCR가 표에서 데이터 행을 찾지 못했습니다.");
        }
        const columns = Array.from({ length: width }, (_, i) => {
            const headerText = headerRow?.[i]?.trim();
            return {
                header: headerText || `열 ${i + 1}`,
                lang: classifyLang(dataRows.map((r) => r[i] ?? "")),
            };
        });
        const rows = dataRows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
        return { columns, rows };
    }
    finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
