"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTableFromImage = extractTableFromImage;
const SYSTEM_PROMPT = `You are a precise table-extraction assistant for scanned/photographed study tables that mix English and Korean text.
Rules:
- Extract the table exactly as written. Do NOT translate, correct spelling, or paraphrase.
- Preserve every row and every column, in the original order.
- If a cell is empty, use an empty string "".
- For each column, classify its dominant language as "en" (English), "ko" (Korean/Hangul), or "other" (numbers, symbols, mixed/neutral like item numbers).
- CRITICAL: every visually distinct column — INCLUDING a leading item-number/index column even if it has no header text — MUST get its own entry in "columns" (lang: "other"). Never fold a number column's values into the next column instead of giving it its own entry.
- The length of every array in "rows" MUST exactly equal the length of "columns". Before answering, count the columns in the image and count the values you put in one row, and verify they match.
- Respond with ONLY a JSON object, no markdown fences, matching exactly this shape:
{
  "columns": [ { "header": "string", "lang": "en|ko|other" }, ... ],
  "rows": [ [ "cell", "cell", ... ], ... ]
}
Each row array length must equal the columns array length.`;
const USER_PROMPT = "이 이미지 속 표를 위 규칙에 따라 JSON으로 추출해줘. 번역하거나 고치지 말고 원문 그대로 옮겨줘.";
// Safety net for a common VLM slip: it emits a leading item-number value in
// every row but forgets to declare that number column in "columns". Without
// this, the later truncate-to-columns-length step silently drops the last
// real column and shifts every other column's values left by one (e.g. the
// "en" column ends up showing the numbers, and "ko" ends up showing English).
// Detected only under a narrow, high-confidence signal: every row has
// exactly one extra value, no column is already tagged "other", and every
// row's first cell is a bare number — otherwise we leave the data untouched
// rather than guess.
function repairMissingLeadingNumberColumn(parsed) {
    const rows = (parsed.rows ?? []).filter((r) => Array.isArray(r));
    if (!rows.length || !parsed.columns)
        return;
    const rowLen = rows[0].length;
    const allSameLen = rows.every((r) => r.length === rowLen);
    if (!allSameLen)
        return;
    if (rowLen - parsed.columns.length !== 1)
        return;
    if (parsed.columns.some((c) => c?.lang === "other"))
        return;
    const firstCellsLookNumeric = rows.every((r) => /^\s*\d+\s*\.?\s*$/.test(String(r[0] ?? "")));
    if (!firstCellsLookNumeric)
        return;
    parsed.columns = [{ header: "순번", lang: "other" }, ...parsed.columns];
}
async function callOpenAI({ apiKey, dataUrl, model, }) {
    if (!apiKey) {
        throw new Error("OpenAI API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.");
    }
    const body = {
        model: model || "gpt-4o",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    { type: "text", text: USER_PROMPT },
                    { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
                ],
            },
        ],
    };
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        let detail = "";
        try {
            const errJson = await res.json();
            detail = errJson?.error?.message || JSON.stringify(errJson);
        }
        catch {
            detail = await res.text();
        }
        throw new Error(`OpenAI API 오류 (${res.status}): ${detail}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("OpenAI 응답에서 내용을 찾을 수 없습니다.");
    }
    return content;
}
async function callOllamaOnce({ url, model, base64, useJsonFormat, }) {
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: model || "llama3.2-vision",
                stream: false,
                think: false,
                ...(useJsonFormat ? { format: "json" } : {}),
                options: { temperature: 0, num_predict: 8192, num_ctx: 8192 },
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: USER_PROMPT, images: [base64] },
                ],
            }),
        });
    }
    catch (err) {
        throw new Error(`Ollama 서버(${url})에 연결하지 못했습니다. Ollama가 실행 중인지 확인해주세요. (${err.message})`);
    }
    if (!res.ok) {
        let detail = "";
        try {
            detail = await res.text();
        }
        catch {
            // ignore
        }
        throw new Error(`Ollama 오류 (${res.status}): ${detail}`);
    }
    const json = await res.json();
    if (json?.error) {
        throw new Error(`Ollama 오류: ${json.error}`);
    }
    return { content: json?.message?.content, raw: json };
}
// Some "thinking" models (e.g. qwen3-vl) don't honor the think:false request
// and still write their whole reply as a <think>...</think> reasoning trace,
// leaving "content" empty — especially if generation got cut off before the
// closing tag. If that reasoning trace still contains a JSON object, salvage
// it rather than failing outright (the downstream JSON.parse still rejects
// it if it's not actually valid/complete).
function extractJsonBlob(text) {
    if (typeof text !== "string")
        return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start)
        return null;
    return text.slice(start, end + 1);
}
async function callOllama({ dataUrl, baseUrl, model, }) {
    const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
    const url = `${(baseUrl || "http://localhost:11434").replace(/\/+$/, "")}/api/chat`;
    let { content, raw } = await callOllamaOnce({ url, model, base64, useJsonFormat: true });
    if (!content || !content.trim()) {
        // Some models return empty output when a strict JSON-grammar constraint
        // is combined with image input — retry once without forcing it. The
        // JSON.parse step downstream still validates/rejects malformed output.
        ({ content, raw } = await callOllamaOnce({ url, model, base64, useJsonFormat: false }));
    }
    if (!content || !content.trim()) {
        const salvaged = extractJsonBlob(raw?.message?.thinking);
        if (salvaged)
            content = salvaged;
    }
    if (!content || !content.trim()) {
        throw new Error(`Ollama 응답에서 내용을 찾을 수 없습니다. 모델이 빈 응답을 반환했습니다. (모델: ${model || "llama3.2-vision"}, 원본 응답: ${JSON.stringify(raw).slice(0, 300)})`);
    }
    return content;
}
async function extractTableFromImage({ provider, apiKey, dataUrl, model, ollamaBaseUrl, ollamaModel, }) {
    const content = provider === "ollama"
        ? await callOllama({ dataUrl, baseUrl: ollamaBaseUrl, model: ollamaModel })
        : await callOpenAI({ apiKey, dataUrl, model });
    const sourceLabel = provider === "ollama" ? "Ollama" : "OpenAI";
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        throw new Error(`${sourceLabel} 응답을 JSON으로 해석하지 못했습니다.`);
    }
    if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
        throw new Error(`${sourceLabel} 응답 형식이 예상과 다릅니다 (columns/rows 누락).`);
    }
    repairMissingLeadingNumberColumn(parsed);
    const columns = parsed.columns.map((c, i) => ({
        header: typeof c?.header === "string" && c.header.trim() ? c.header : `열 ${i + 1}`,
        lang: ["en", "ko", "other"].includes(c?.lang) ? c.lang : "other",
    }));
    const rows = parsed.rows.map((row) => {
        const r = Array.isArray(row) ? row.slice() : [];
        while (r.length < columns.length)
            r.push("");
        return r.slice(0, columns.length).map((cell) => (cell == null ? "" : String(cell)));
    });
    return { columns, rows };
}
