"use strict";
(() => {
    const DEFAULT_TITLE = "영어 단어 테스트";
    // Height budget of one landscape A4 column: 22 rows (21 + the header) at the
    // 28px row height set for .sheet.landscape is ~163mm, which together with
    // the 24mm padding, the title block and a per-table caption stays under
    // 210mm. Raising this is what makes a landscape sheet spill onto a 2nd page.
    const ROWS_PER_LANDSCAPE_COLUMN = 21;
    let items = [];
    let nextId = 1;
    let activeEditorId = null;
    let progressTimer;
    function $(sel) {
        return document.querySelector(sel);
    }
    function $$(sel, root = document) {
        return Array.from(root.querySelectorAll(sel));
    }
    function escapeHtml(str) {
        return String(str)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    }
    function activeItem() {
        return items.find((it) => it.id === activeEditorId);
    }
    // ---------- Step navigation ----------
    function goToStep(step) {
        $$(".step-panel").forEach((p) => p.classList.toggle("active", p.id === step));
        $$(".step-btn").forEach((b) => b.classList.toggle("active", b.dataset.step === step));
    }
    function unlockStep(step) {
        const btn = $(`.step-btn[data-step="${step}"]`);
        if (btn)
            btn.disabled = false;
    }
    $$(".step-btn").forEach((b) => {
        b.addEventListener("click", () => {
            if (!b.disabled)
                goToStep(b.dataset.step);
        });
    });
    // ---------- Settings modal ----------
    const settingsModal = $("#settingsModal");
    const providerSelect = $("#providerSelect");
    const paddleFields = $("#paddleFields");
    const openaiFields = $("#openaiFields");
    const ollamaFields = $("#ollamaFields");
    const settingsHint = $("#settingsHint");
    const PROVIDER_HINTS = {
        paddle: "이 PC의 Python(3.9~3.13) + PaddleOCR로 인식합니다 (오프라인/무료). 미리 'pip install paddlepaddle \"paddleocr[doc-parser]\"'가 필요하며, 최초 실행 시 모델 다운로드로 시간이 걸릴 수 있어요.",
        openai: "표 인식(Vision)에 사용됩니다. 키는 이 PC에만 저장됩니다.",
        ollama: "이 PC(또는 지정한 주소)에 Ollama가 실행 중이어야 합니다. 인식 정확도는 GPT-4o보다 낮을 수 있어요.",
    };
    function updateProviderFieldsVisibility() {
        const provider = providerSelect.value;
        paddleFields.hidden = provider !== "paddle";
        openaiFields.hidden = provider !== "openai";
        ollamaFields.hidden = provider !== "ollama";
        settingsHint.textContent = PROVIDER_HINTS[provider] || PROVIDER_HINTS.paddle;
    }
    providerSelect.addEventListener("change", updateProviderFieldsVisibility);
    $("#settingsBtn").addEventListener("click", async () => {
        const s = await window.api.getSettings();
        providerSelect.value = s.provider || "paddle";
        $("#apiKeyInput").value = s.apiKey || "";
        $("#ollamaBaseUrlInput").value = s.ollamaBaseUrl || "http://localhost:11434";
        $("#ollamaModelInput").value = s.ollamaModel || "llama3.2-vision";
        $("#paddlePythonPathInput").value = s.paddlePythonPath || "python";
        updateProviderFieldsVisibility();
        $("#settingsStatus").hidden = true;
        settingsModal.hidden = false;
    });
    $("#closeSettingsBtn").addEventListener("click", () => (settingsModal.hidden = true));
    $("#saveSettingsBtn").addEventListener("click", async () => {
        const statusBox = $("#settingsStatus");
        const saveBtn = $("#saveSettingsBtn");
        const provider = providerSelect.value;
        const key = $("#apiKeyInput").value.trim();
        const ollamaBaseUrl = $("#ollamaBaseUrlInput").value.trim() || "http://localhost:11434";
        const ollamaModel = $("#ollamaModelInput").value.trim() || "llama3.2-vision";
        const paddlePythonPath = $("#paddlePythonPathInput").value.trim() || "python";
        if (provider === "openai" && !key) {
            statusBox.hidden = false;
            statusBox.className = "settings-status error";
            statusBox.textContent = "API 키를 입력해주세요.";
            return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = "저장 중...";
        try {
            const result = await window.api.saveSettings({ provider, apiKey: key, ollamaBaseUrl, ollamaModel, paddlePythonPath });
            if (result && result.ok) {
                statusBox.hidden = false;
                statusBox.className = "settings-status success";
                statusBox.textContent = "저장되었습니다.";
                setTimeout(() => {
                    settingsModal.hidden = true;
                    statusBox.hidden = true;
                }, 600);
            }
            else {
                throw new Error((result && result.error) || "알 수 없는 오류");
            }
        }
        catch (err) {
            statusBox.hidden = false;
            statusBox.className = "settings-status error";
            statusBox.textContent = "저장 실패: " + String(err?.message || err);
        }
        finally {
            saveBtn.disabled = false;
            saveBtn.textContent = "저장";
        }
    });
    async function ensureApiKey() {
        const s = await window.api.getSettings();
        if ((s.provider || "paddle") === "openai" && !s.apiKey) {
            providerSelect.value = "openai";
            $("#apiKeyInput").value = "";
            updateProviderFieldsVisibility();
            $("#settingsStatus").hidden = true;
            settingsModal.hidden = false;
            return false;
        }
        return true;
    }
    // ---------- Upload ----------
    const dropZone = $("#dropZone");
    const fileInput = $("#fileInput");
    const previewList = $("#previewList");
    const extractBtn = $("#extractBtn");
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
        if (files.length)
            addFiles(files);
    });
    fileInput.addEventListener("change", () => {
        const files = fileInput.files ? Array.from(fileInput.files) : [];
        if (files.length)
            addFiles(files);
        fileInput.value = "";
    });
    function addFiles(files) {
        const imageFiles = files.filter((f) => f.type.startsWith("image/"));
        if (!imageFiles.length) {
            showUploadError("이미지 파일만 업로드할 수 있습니다.");
            return;
        }
        hideUploadError();
        imageFiles.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
                const id = nextId++;
                items.push({ id, fileName: file.name, dataUrl: reader.result, tableData: null });
                renderPreviewList();
                updateExtractBtnState();
            };
            reader.readAsDataURL(file);
        });
    }
    function renderPreviewList() {
        previewList.innerHTML = items
            .map((it) => `
      <div class="thumb-item" data-id="${it.id}">
        <img src="${it.dataUrl}" alt="${escapeHtml(it.fileName)}" />
        <div class="thumb-name">${escapeHtml(it.fileName)}</div>
        <button class="thumb-del-btn" data-id="${it.id}" title="제거">✕</button>
      </div>`)
            .join("");
        $$(".thumb-del-btn", previewList).forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = Number(btn.dataset.id);
                items = items.filter((it) => it.id !== id);
                renderPreviewList();
                updateExtractBtnState();
            });
        });
    }
    function updateExtractBtnState() {
        extractBtn.disabled = items.length === 0;
    }
    function showUploadError(msg) {
        const box = $("#uploadError");
        box.textContent = msg;
        box.hidden = false;
    }
    function hideUploadError() {
        $("#uploadError").hidden = true;
    }
    // ---------- Progress bar ----------
    function startProgress() {
        const wrap = $("#progressWrap");
        const bar = $("#progressBar");
        const label = $("#progressLabel");
        wrap.hidden = false;
        let pct = 0;
        bar.style.width = "0%";
        label.textContent = "이미지 준비 중...";
        setTimeout(() => {
            pct = 20;
            bar.style.width = pct + "%";
            label.textContent = "이미지 인코딩 중...";
        }, 200);
        setTimeout(() => {
            pct = 35;
            bar.style.width = pct + "%";
            label.textContent = "AI 서버로 전송 중...";
        }, 600);
        clearInterval(progressTimer);
        progressTimer = setInterval(() => {
            pct = Math.min(pct + 1, 88);
            bar.style.width = pct + "%";
        }, 350);
    }
    function updateProgressLabel(text) {
        $("#progressLabel").textContent = text;
    }
    function finishProgress(success, message) {
        clearInterval(progressTimer);
        const bar = $("#progressBar");
        const label = $("#progressLabel");
        bar.style.width = "100%";
        label.textContent = message || (success ? "완료되었습니다." : "오류가 발생했습니다.");
        setTimeout(() => {
            $("#progressWrap").hidden = true;
        }, success ? 700 : 0);
    }
    // ---------- Extraction ----------
    extractBtn.addEventListener("click", async () => {
        if (!items.length)
            return;
        const ok = await ensureApiKey();
        if (!ok)
            return;
        hideUploadError();
        extractBtn.disabled = true;
        const pendingItems = items.filter((it) => !it.tableData);
        if (!pendingItems.length) {
            openEditorWithItems();
            extractBtn.disabled = false;
            return;
        }
        startProgress();
        try {
            const settings = await window.api.getSettings();
            if (settings.provider === "ollama") {
                updateProgressLabel("Ollama 서버 확인 중...");
                const readiness = await window.api.ensureOllamaReady(settings.ollamaBaseUrl);
                if (!readiness.ok) {
                    throw new Error(readiness.error || "Ollama 서버를 사용할 수 없습니다.");
                }
            }
            const engineName = settings.provider === "paddle" ? "PaddleOCR" : "AI";
            for (let i = 0; i < pendingItems.length; i++) {
                const it = pendingItems[i];
                updateProgressLabel(pendingItems.length > 1
                    ? `${engineName}가 표를 분석하는 중입니다 (${i + 1}/${pendingItems.length})...`
                    : `${engineName}가 표를 분석하는 중입니다... 시간이 걸릴 수 있어요.`);
                it.tableData = await window.api.extractTable(it.dataUrl);
            }
            finishProgress(true, "인식이 완료되었습니다.");
            openEditorWithItems();
        }
        catch (err) {
            finishProgress(false, "오류가 발생했습니다.");
            showUploadError(String(err?.message || err));
        }
        finally {
            extractBtn.disabled = false;
        }
    });
    function openEditorWithItems() {
        activeEditorId = items[0].id;
        renderEditorTabs();
        renderEditorTable();
        unlockStep("editor");
        goToStep("editor");
    }
    // ---------- Editor ----------
    function renderEditorTabs() {
        const wrap = $("#editorTabs");
        if (items.length <= 1) {
            wrap.hidden = true;
            wrap.innerHTML = "";
            return;
        }
        wrap.hidden = false;
        wrap.innerHTML = items
            .map((it, idx) => `
      <button class="editor-tab-btn ${it.id === activeEditorId ? "active" : ""}" data-id="${it.id}">${idx + 1}. ${escapeHtml(it.fileName)}</button>`)
            .join("");
        $$(".editor-tab-btn", wrap).forEach((btn) => {
            btn.addEventListener("click", () => {
                const id = Number(btn.dataset.id);
                if (id === activeEditorId)
                    return;
                syncTableDataFromEditorDom();
                activeEditorId = id;
                renderEditorTabs();
                renderEditorTable();
            });
        });
    }
    function renderEditorTable() {
        const wrap = $("#editorTableWrap");
        const item = activeItem();
        const tableData = item && item.tableData;
        if (!tableData || !tableData.columns.length) {
            wrap.innerHTML = "<p>인식된 표가 없습니다.</p>";
            return;
        }
        const langLabel = { en: "영어", ko: "한글", other: "기타" };
        let html = '<table class="edit-table"><thead><tr>';
        tableData.columns.forEach((col, ci) => {
            html += `<th data-col="${ci}">
        <div contenteditable="true" class="col-header" data-col="${ci}">${escapeHtml(col.header)}</div>
        <select class="col-lang" data-col="${ci}">
          <option value="en" ${col.lang === "en" ? "selected" : ""}>${langLabel.en}</option>
          <option value="ko" ${col.lang === "ko" ? "selected" : ""}>${langLabel.ko}</option>
          <option value="other" ${col.lang === "other" ? "selected" : ""}>${langLabel.other}</option>
        </select>
      </th>`;
        });
        html += "<th>삭제</th></tr></thead><tbody>";
        tableData.rows.forEach((row, ri) => {
            html += `<tr data-row="${ri}">`;
            row.forEach((cell, ci) => {
                html += `<td contenteditable="true" data-row="${ri}" data-col="${ci}">${escapeHtml(cell)}</td>`;
            });
            html += `<td><button class="row-del-btn" data-row="${ri}">✕ 삭제</button></td></tr>`;
        });
        html += "</tbody></table>";
        wrap.innerHTML = html;
        $$(".col-lang", wrap).forEach((sel) => {
            sel.addEventListener("change", () => {
                tableData.columns[Number(sel.dataset.col)].lang = sel.value;
            });
        });
        $$(".row-del-btn", wrap).forEach((btn) => {
            btn.addEventListener("click", () => {
                tableData.rows.splice(Number(btn.dataset.row), 1);
                renderEditorTable();
            });
        });
    }
    function syncTableDataFromEditorDom() {
        const item = activeItem();
        const tableData = item && item.tableData;
        if (!tableData)
            return;
        const wrap = $("#editorTableWrap");
        $$(".col-header", wrap).forEach((el) => {
            tableData.columns[Number(el.dataset.col)].header = (el.textContent ?? "").trim();
        });
        $$('td[contenteditable="true"]', wrap).forEach((el) => {
            const r = Number(el.dataset.row);
            const c = Number(el.dataset.col);
            tableData.rows[r][c] = el.textContent ?? "";
        });
    }
    // ---------- Preview ----------
    $("#toPreviewBtn").addEventListener("click", () => {
        if (!items.length)
            return;
        syncTableDataFromEditorDom();
        renderAllSheets();
        unlockStep("preview");
        goToStep("preview");
    });
    $("#backToEditorBtn").addEventListener("click", () => goToStep("editor"));
    // The layout drives both the sheet HTML and the paper orientation, so the
    // print/PDF buttons read it instead of carrying a fixed orientation.
    const layoutSelect = $("#layoutSelect");
    function currentLayout() {
        return layoutSelect.value === "landscape2" ? "landscape2" : "portrait";
    }
    function currentOrientation() {
        return currentLayout() === "landscape2" ? "landscape" : "portrait";
    }
    layoutSelect.addEventListener("change", () => {
        if (items.length)
            renderAllSheets();
    });
    $$(".ptab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            $$(".ptab-btn").forEach((b) => b.classList.toggle("active", b === btn));
            $$(".ptab-panel").forEach((p) => p.classList.toggle("active", p.id === `ptab-panel-${btn.dataset.ptab}`));
        });
    });
    // Builds one sheet's table HTML: only the columns whose lang is in
    // keepLangs are shown (item-number/"other" columns are always dropped —
    // they're not needed on the printed practice sheet), in their original
    // relative order. Each kept column is immediately followed by its own
    // blank answer column (so if two columns share the same kept language,
    // you get col,blank,col,blank — not both columns bunched together with a
    // single trailing blank).
    const CONTENT_HEADER_LABEL = { en: "영어", ko: "한글" };
    function buildFilteredTableHtml(columns, rows, keepLangs, answerColumnLabel) {
        const indices = columns.map((_c, i) => i).filter((i) => keepLangs.includes(columns[i].lang));
        let html = '<table class="print-table"><thead><tr>';
        indices.forEach((i) => {
            const headerText = CONTENT_HEADER_LABEL[columns[i].lang] || columns[i].header;
            html += `<th>${escapeHtml(headerText)}</th>`;
            if (answerColumnLabel)
                html += `<th class="answer-col">${escapeHtml(answerColumnLabel)}</th>`;
        });
        html += "</tr></thead><tbody>";
        rows.forEach((row) => {
            html += "<tr>";
            indices.forEach((i) => {
                html += `<td>${escapeHtml(row[i] ?? "")}</td>`;
                if (answerColumnLabel)
                    html += `<td class="answer-cell"></td>`;
            });
            html += "</tr>";
        });
        html += "</tbody></table>";
        return html;
    }
    function sheetHead(title, heading, sub) {
        return `<h2 class="sheet-title">${escapeHtml(title)} — ${heading}</h2>
        <p class="sheet-sub">${escapeHtml(sub)}</p>`;
    }
    // One portrait A4 per image, the whole table in a single column.
    function buildPortraitSheet(item, title, heading, sub, keepLangs, answerLabel) {
        const { columns, rows } = item.tableData || { columns: [], rows: [] };
        return `
      <div class="sheet portrait">
        ${sheetHead(title, heading, sub)}
        ${buildFilteredTableHtml(columns, rows, keepLangs, answerLabel)}
      </div>`;
    }
    // Landscape sheets carry two table blocks side by side. Blocks come from
    // every uploaded image in order, so two photos share one page instead of
    // taking one each, and a table too tall for one column is split across as
    // many balanced columns as it needs (30 rows → 15+15, not 21+9).
    function collectLandscapeBlocks() {
        const blocks = [];
        items.forEach((item) => {
            const rows = (item.tableData && item.tableData.rows) || [];
            const parts = Math.max(1, Math.ceil(rows.length / ROWS_PER_LANDSCAPE_COLUMN));
            const size = Math.ceil(rows.length / parts);
            for (let p = 0; p < parts; p++) {
                blocks.push({ item, rows: rows.slice(p * size, (p + 1) * size) });
            }
        });
        // A single short table would otherwise leave half the sheet blank, so
        // halve it — the page then really does hold the two tables it promises.
        if (blocks.length === 1 && blocks[0].rows.length > 1) {
            const only = blocks[0];
            const half = Math.ceil(only.rows.length / 2);
            return [
                { item: only.item, rows: only.rows.slice(0, half) },
                { item: only.item, rows: only.rows.slice(half) },
            ];
        }
        return blocks;
    }
    function buildLandscapeBlockHtml(block, multi, keepLangs, answerLabel) {
        const columns = (block.item.tableData && block.item.tableData.columns) || [];
        // With one image there's nothing to tell apart, so the caption only earns
        // its vertical space when blocks can come from different photos.
        const caption = multi ? `<p class="col-caption">${escapeHtml(block.item.fileName)}</p>` : "";
        return `<div class="sheet-col">
            ${caption}
            ${buildFilteredTableHtml(columns, block.rows, keepLangs, answerLabel)}
          </div>`;
    }
    function buildLandscapeSheets(title, dateStr, multi, heading, keepLangs, answerLabel) {
        const blocks = collectLandscapeBlocks();
        const pages = [];
        for (let i = 0; i < blocks.length; i += 2)
            pages.push(blocks.slice(i, i + 2));
        return pages
            .map((pageBlocks, pi) => {
            const sub = pages.length > 1 ? `${dateStr} · ${pi + 1}/${pages.length}쪽` : dateStr;
            const cols = pageBlocks
                .map((block) => buildLandscapeBlockHtml(block, multi, keepLangs, answerLabel))
                .join("\n          ");
            // An odd number of blocks leaves the last right half empty; the
            // filler keeps the lone table at half width instead of stretching it.
            const filler = pageBlocks.length < 2 ? '<div class="sheet-col"></div>' : "";
            return `
      <div class="sheet landscape">
        ${sheetHead(title, heading, sub)}
        <div class="sheet-cols">
          ${cols}
          ${filler}
        </div>
      </div>`;
        })
            .join("");
    }
    function buildSheets(title, dateStr, multi, heading, keepLangs, answerLabel) {
        if (currentLayout() === "landscape2") {
            return buildLandscapeSheets(title, dateStr, multi, heading, keepLangs, answerLabel);
        }
        return items
            .map((it, idx) => {
            const sub = multi ? `${dateStr} · ${it.fileName} (${idx + 1}/${items.length})` : dateStr;
            return buildPortraitSheet(it, title, heading, sub, keepLangs, answerLabel);
        })
            .join("");
    }
    function renderAllSheets() {
        const title = $("#titleInput").value.trim() || DEFAULT_TITLE;
        const dateStr = new Date().toLocaleDateString("ko-KR");
        const multi = items.length > 1;
        $("#sheet-en-wrap").innerHTML = buildSheets(title, dateStr, multi, "English", ["en"], "한글 뜻 쓰기");
        $("#sheet-ko-wrap").innerHTML = buildSheets(title, dateStr, multi, "한글", ["ko"], "English 쓰기");
    }
    // ---------- Print / PDF ----------
    function setPageCss(orientation) {
        let style = document.getElementById("page-size-style");
        if (!style) {
            style = document.createElement("style");
            style.id = "page-size-style";
            document.head.appendChild(style);
        }
        // .sheet is already sized to the full physical page (210mm/297mm) with
        // its own 18mm/14mm padding acting as the margin — a nonzero @page
        // margin here would shrink the printable area out from under that
        // already-full-width box and clip the edges, so this stays at 0.
        style.textContent = `@page { size: A4 ${orientation}; margin: 0; }`;
    }
    $$("[data-print]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const orientation = currentOrientation();
            setPageCss(orientation);
            await window.api.printNow(orientation === "landscape");
        });
    });
    $$("[data-pdf]").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const orientation = currentOrientation();
            const target = btn.dataset.target;
            setPageCss(orientation);
            const title = ($("#titleInput").value.trim() || DEFAULT_TITLE).replace(/[\\/:*?"<>|]/g, "_");
            const suffix = target ? { en: "_EN", ko: "_KO" }[target] || "" : "";
            const result = await window.api.exportPdf(orientation === "landscape", `${title}${suffix}.pdf`);
            if (result && !result.canceled) {
                alert(`PDF로 저장했습니다:\n${result.filePath}`);
            }
        });
    });
})();
