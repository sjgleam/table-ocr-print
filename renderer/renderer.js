(() => {
  let items = []; // { id, fileName, baseName, dataUrl, tableData }
  let nextId = 1;
  let activeEditorId = null;
  let progressTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
    if (btn) btn.disabled = false;
  }
  $$(".step-btn").forEach((b) => {
    b.addEventListener("click", () => {
      if (!b.disabled) goToStep(b.dataset.step);
    });
  });

  // ---------- Settings modal ----------
  const settingsModal = $("#settingsModal");
  const providerSelect = $("#providerSelect");
  const openaiFields = $("#openaiFields");
  const ollamaFields = $("#ollamaFields");
  const settingsHint = $("#settingsHint");

  function updateProviderFieldsVisibility() {
    const isOllama = providerSelect.value === "ollama";
    openaiFields.hidden = isOllama;
    ollamaFields.hidden = !isOllama;
    settingsHint.textContent = isOllama
      ? "이 PC(또는 지정한 주소)에 Ollama가 실행 중이어야 합니다. 인식 정확도는 GPT-4o보다 낮을 수 있어요."
      : "표 인식(Vision)에 사용됩니다. 키는 이 PC에만 저장됩니다.";
  }
  providerSelect.addEventListener("change", updateProviderFieldsVisibility);

  $("#settingsBtn").addEventListener("click", async () => {
    const s = await window.api.getSettings();
    providerSelect.value = s.provider || "openai";
    $("#apiKeyInput").value = s.apiKey || "";
    $("#ollamaBaseUrlInput").value = s.ollamaBaseUrl || "http://localhost:11434";
    $("#ollamaModelInput").value = s.ollamaModel || "llama3.2-vision";
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

    if (provider === "openai" && !key) {
      statusBox.hidden = false;
      statusBox.className = "settings-status error";
      statusBox.textContent = "API 키를 입력해주세요.";
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "저장 중...";
    try {
      const result = await window.api.saveSettings({ provider, apiKey: key, ollamaBaseUrl, ollamaModel });
      if (result && result.ok) {
        statusBox.hidden = false;
        statusBox.className = "settings-status success";
        statusBox.textContent = "저장되었습니다.";
        setTimeout(() => {
          settingsModal.hidden = true;
          statusBox.hidden = true;
        }, 600);
      } else {
        throw new Error((result && result.error) || "알 수 없는 오류");
      }
    } catch (err) {
      statusBox.hidden = false;
      statusBox.className = "settings-status error";
      statusBox.textContent = "저장 실패: " + String(err?.message || err);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "저장";
    }
  });

  async function ensureApiKey() {
    const s = await window.api.getSettings();
    if ((s.provider || "openai") === "openai" && !s.apiKey) {
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
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) addFiles(files);
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    if (files.length) addFiles(files);
    fileInput.value = "";
  });

  function addFiles(files) {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) {
      showUploadError("이미지 파일만 업로드할 수 있습니다.");
      return;
    }
    hideUploadError();
    const hadNoItems = items.length === 0;
    imageFiles.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = () => {
        const id = nextId++;
        const baseName = file.name.replace(/\.[^.]+$/, "") || `표${id}`;
        items.push({ id, fileName: file.name, baseName, dataUrl: reader.result, tableData: null });
        if (hadNoItems && idx === 0 && !$("#titleInput").value.trim()) {
          $("#titleInput").value = baseName;
        }
        renderPreviewList();
        updateExtractBtnState();
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPreviewList() {
    previewList.innerHTML = items
      .map(
        (it) => `
      <div class="thumb-item" data-id="${it.id}">
        <img src="${it.dataUrl}" alt="${escapeHtml(it.fileName)}" />
        <div class="thumb-name">${escapeHtml(it.fileName)}</div>
        <button class="thumb-del-btn" data-id="${it.id}" title="제거">✕</button>
      </div>`
      )
      .join("");
    previewList.querySelectorAll(".thumb-del-btn").forEach((btn) => {
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
    if (!items.length) return;
    const ok = await ensureApiKey();
    if (!ok) return;

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

      for (let i = 0; i < pendingItems.length; i++) {
        const it = pendingItems[i];
        updateProgressLabel(
          pendingItems.length > 1
            ? `AI가 표를 분석하는 중입니다 (${i + 1}/${pendingItems.length})...`
            : "AI가 표를 분석하는 중입니다... 시간이 걸릴 수 있어요."
        );
        it.tableData = await window.api.extractTable(it.dataUrl);
      }
      finishProgress(true, "인식이 완료되었습니다.");
      openEditorWithItems();
    } catch (err) {
      finishProgress(false, "오류가 발생했습니다.");
      showUploadError(String(err?.message || err));
    } finally {
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
      .map(
        (it, idx) => `
      <button class="editor-tab-btn ${it.id === activeEditorId ? "active" : ""}" data-id="${it.id}">${idx + 1}. ${escapeHtml(it.fileName)}</button>`
      )
      .join("");
    wrap.querySelectorAll(".editor-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.id);
        if (id === activeEditorId) return;
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

    wrap.querySelectorAll(".col-lang").forEach((sel) => {
      sel.addEventListener("change", () => {
        tableData.columns[Number(sel.dataset.col)].lang = sel.value;
      });
    });
    wrap.querySelectorAll(".row-del-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        tableData.rows.splice(Number(btn.dataset.row), 1);
        renderEditorTable();
      });
    });
  }

  function syncTableDataFromEditorDom() {
    const item = activeItem();
    const tableData = item && item.tableData;
    if (!tableData) return;
    const wrap = $("#editorTableWrap");
    wrap.querySelectorAll(".col-header").forEach((el) => {
      tableData.columns[Number(el.dataset.col)].header = el.textContent.trim();
    });
    wrap.querySelectorAll('td[contenteditable="true"]').forEach((el) => {
      const r = Number(el.dataset.row);
      const c = Number(el.dataset.col);
      tableData.rows[r][c] = el.textContent;
    });
  }

  // ---------- Preview ----------
  $("#toPreviewBtn").addEventListener("click", () => {
    if (!items.length) return;
    syncTableDataFromEditorDom();
    renderAllSheets();
    unlockStep("preview");
    goToStep("preview");
  });
  $("#backToEditorBtn").addEventListener("click", () => goToStep("editor"));

  $$(".ptab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".ptab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".ptab-panel").forEach((p) =>
        p.classList.toggle("active", p.id === `ptab-panel-${btn.dataset.ptab}`)
      );
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
    const indices = columns.map((c, i) => i).filter((i) => keepLangs.includes(columns[i].lang));
    let html = '<table class="print-table"><thead><tr>';
    indices.forEach((i) => {
      const headerText = CONTENT_HEADER_LABEL[columns[i].lang] || columns[i].header;
      html += `<th>${escapeHtml(headerText)}</th>`;
      if (answerColumnLabel) html += `<th class="answer-col">${escapeHtml(answerColumnLabel)}</th>`;
    });
    html += "</tr></thead><tbody>";
    rows.forEach((row) => {
      html += "<tr>";
      indices.forEach((i) => {
        html += `<td>${escapeHtml(row[i] ?? "")}</td>`;
        if (answerColumnLabel) html += `<td class="answer-cell"></td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  function buildSheetPage(item, idx, title, dateStr, multi, heading, keepLangs, answerLabel) {
    const { columns, rows } = item.tableData || { columns: [], rows: [] };
    const sub = multi ? `${dateStr} · ${item.fileName} (${idx + 1}/${items.length})` : dateStr;
    return `
      <div class="sheet portrait">
        <h2 class="sheet-title">${escapeHtml(title)} — ${heading}</h2>
        <p class="sheet-sub">${escapeHtml(sub)}</p>
        ${buildFilteredTableHtml(columns, rows, keepLangs, answerLabel)}
      </div>`;
  }

  function renderAllSheets() {
    const title = $("#titleInput").value.trim() || (items[0] && items[0].baseName) || "table";
    const dateStr = new Date().toLocaleDateString("ko-KR");
    const multi = items.length > 1;

    $("#sheet-en-wrap").innerHTML = items
      .map((it, idx) => buildSheetPage(it, idx, title, dateStr, multi, "English", ["en"], "한글 뜻 쓰기"))
      .join("");

    $("#sheet-ko-wrap").innerHTML = items
      .map((it, idx) => buildSheetPage(it, idx, title, dateStr, multi, "한글", ["ko"], "English 쓰기"))
      .join("");
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
      const orientation = btn.dataset.print;
      setPageCss(orientation);
      await window.api.printNow(orientation === "landscape");
    });
  });

  $$("[data-pdf]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orientation = btn.dataset.pdf;
      const target = btn.dataset.target;
      setPageCss(orientation);
      const fallbackName = (items[0] && items[0].baseName) || "table";
      const title = ($("#titleInput").value.trim() || fallbackName).replace(/[\\/:*?"<>|]/g, "_");
      const suffix = { en: "_EN", ko: "_KO" }[target] || "";
      const result = await window.api.exportPdf(orientation === "landscape", `${title}${suffix}.pdf`);
      if (result && !result.canceled) {
        alert(`PDF로 저장했습니다:\n${result.filePath}`);
      }
    });
  });
})();
