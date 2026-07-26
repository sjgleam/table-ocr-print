# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows Electron app that reads a photographed English/Korean vocabulary table and prints two
practice sheets from it: English-only (write the Korean meaning) and Korean-only (write the English).
UI text and commit-facing docs are Korean; code and comments are English.

## Commands

```
npm start          # tsc && electron .   -- the normal way to run it
npm run build      # tsc only (type-check + emit .js next to each .ts)
npm run dist       # tsc && electron-builder --win  (NSIS installer)
```

There is no test suite and no linter. `tsc` with `noEmitOnError` is the only gate, so
**always run `npm run build` after editing any `.ts`** — the app loads the emitted `.js`, and a
stale or missing `.js` is the usual cause of "my change did nothing".

`launch.vbs` is a windowless launcher for the desktop shortcut; it runs
`node_modules\electron\dist\electron.exe` directly, so it needs `node_modules` present and does
**not** compile TypeScript first.

## Build layout you must keep in mind

TypeScript emits alongside the sources (no `dist/`), so `main.ts` → `main.js`, `src/paddle.ts` →
`src/paddle.js`, `renderer/renderer.ts` → `renderer/renderer.js`. Both the `.ts` and the generated
`.js` are committed. `renderer/renderer.ts` is deliberately a classic script with no imports —
`renderer/window.d.ts` supplies the ambient `window.api` type instead — because `index.html` loads
it with a plain `<script src>`.

`scripts/paddle_table.py` is not compiled; it ships as-is and is listed separately in the
electron-builder `files` array.

## Architecture

Three processes, not two:

1. **Main** (`main.ts`) — owns settings, printing, and PDF export. Settings live in
   `%APPDATA%\table-ocr-print\settings.json` (outside the repo, gitignored). The `extract-table`
   IPC handler is the fork point: `provider === "paddle"` goes to `src/paddle.ts`, anything else to
   `src/vlm.ts`.
2. **Renderer** (`renderer/`) — a 3-step wizard (upload → edit → preview) holding all state in the
   module-scoped `items` array. Everything reaches main through `window.api`, defined once in
   `preload.ts` and typed by `WindowApi` in `src/types.d.ts`.
3. **A Python child process** — PaddleOCR runs out-of-process. `src/paddle.ts` writes the image to
   a temp dir, spawns `scripts/paddle_table.py`, and parses **the last stdout line starting with
   `{`** (PaddleOCR logs freely before it). The script always prints exactly one JSON object,
   `{"cells": [...]}` or `{"error": "..."}`, ASCII-escaped so Windows cp949 consoles cannot corrupt
   Hangul.

Both recognition paths converge on `TableData` = `{ columns: [{header, lang}], rows: string[][] }`
where `lang` is `en | ko | other`. Everything downstream keys off `lang`: the printed sheets keep
only `en` (or only `ko`) columns and drop `other` entirely, inserting a blank answer column after
each kept column.

The difference between the two paths is who decides the language: the VLM returns `lang` itself,
while OCR returns only text, so `src/paddle.ts` classifies each column by counting Hangul vs Latin
characters and detects a header row heuristically (known header words, or a numeric first column in
the data rows but not row 0).

Both paths also upscale the image first, for the same reason (glyph height drives accuracy): Paddle
does it in Python, the VLM path in `src/image.ts` via Electron's `nativeImage` — hence
`extract-table` only calls `upscaleForRecognition()` on the non-Paddle branch.

The preview builds two sheet layouts from the same `TableData`: portrait (one table per image, the
original) and `landscape2` (two table blocks side by side on a landscape A4). The layout `<select>`
in the preview toolbar also decides the paper orientation passed to `printNow`/`exportPdf`.

## Recognition providers

`provider` is one of `paddle` (default) | `openai` | `ollama`, chosen in the settings modal.
Adding a provider means touching all of: `Provider`/`Settings`/`ResolvedSettings` in
`src/types.d.ts`, the defaults in `get-settings` and the dispatch in `extract-table`
(`main.ts`), the `<select>` plus a field group in `renderer/index.html`, and
`PROVIDER_HINTS` + `updateProviderFieldsVisibility` + the save handler in `renderer/renderer.ts`.

## Non-obvious constraints

These were each found by debugging; changing them re-breaks the app.

- **PaddleOCR needs `enable_mkldnn=False`.** With oneDNN on, paddle 3.3.1 aborts mid-inference with
  `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support`.
- **PaddleOCR needs `use_textline_orientation=False`.** The orientation classifier mistakes short
  table cells for upside-down lines and recognizes them rotated 180° (`amazing`→`buzeue`,
  `12`→`Z1`). Turning it off moved the benchmark from ~56% to ~80%.
- **`pip install paddleocr` is not enough** — PP-StructureV3 needs the extra:
  `pip install paddlepaddle "paddleocr[doc-parser]"`. Python must be 3.9–3.13; there is no
  paddlepaddle wheel for 3.14.
- **Low-resolution photos need upscaling.** `prepare_image()` scales the long side up to 2200px
  (max 3×) because glyph height drives OCR accuracy far more than anything else.
- **`backgroundThrottling: false` on the BrowserWindow** — the native save dialog occludes the
  window, and a throttled page makes `printToPDF` capture a blank frame.
- **Print margins must stay at zero** in both `@page` (renderer) and `printToPDF`
  (`marginType: "none"`). `.sheet` is already sized to a full 210mm page and supplies its own
  padding; any additional margin shrinks the printable area and clips the sheet.
- **`.modal-backdrop[hidden] { display: none }` in `style.css`** — without it the `display: flex`
  rule outranks the `hidden` attribute and the settings modal never closes.
- **A VLM can return a column it declared but never filled.** qwen2.5vl leaves the *rightmost*
  column of a two-block word table `""` in every row (the printed sheet then has an empty 3rd
  column). Upscaling fixes some images, not all, so `repairBlankColumns()` in `src/vlm.ts` re-asks
  the model for that one column and merges the answer only when it returns exactly one value per
  row — a short or long answer means rows were skipped or invented, and mis-paired words are worse
  on a practice sheet than a blank column. Don't drop this in favor of "the prompt says not to":
  it was already told, twice.
- **`ROWS_PER_LANDSCAPE_COLUMN` (renderer) and `.sheet-cols { height }` (CSS) are one setting in
  two files.** The fixed height is what lets the tables stretch to fill a landscape sheet; the row
  cap is what keeps them from outgrowing it. Raising either alone spills the sheet onto a second
  page. The current 21 rows / 170mm leaves ~3mm of slack — at 174mm it already broke.

## Benchmark

`bench/` compares the recognition engines on 100 generated tables with exact ground truth; see
`bench/README.md` to reproduce and `bench/BENCHMARK.md` for results. `bench/images/` is gitignored
and regenerated byte-for-byte by the fixed-seed `bench/generate.py`, so `ground_truth.json` and
`results/` are enough to re-score without re-running any engine.

Headline: OpenAI gpt-4o 99.5% > Ollama qwen2.5vl 91.4% > PaddleOCR 80.1% > qwen3-vl:8b 77.8% >
Tesseract 54.2%, scored on word-pair accuracy (English and Korean both correct **and in the same
row**, because a row-misaligned pair makes the printed sheet useless).
