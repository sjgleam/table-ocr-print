# 작업 진행 상황 (표 OCR 인쇄 도우미)

마지막 업데이트: 2026-07-22

## 프로젝트 개요

사진 속 영어/한글 혼합 표를 VLM(OpenAI GPT-4o Vision)으로 인식한 뒤,
- 영어만 보고 한글 뜻을 맞히는 시험지
- 한글만 보고 영어 표현을 맞히는 시험지

를 만들어 인쇄하거나 PDF로 저장하는 Windows용 Electron 앱.

경로: `C:\Users\jsj\study` (git 저장소 아님)

## 실행 방법

```
npm install   # 최초 1회
npm start
```

바탕화면에 **"표 OCR 인쇄 도우미"** 아이콘이 있어 더블클릭으로도 실행 가능
(`launch.vbs`가 `node_modules\electron\dist\electron.exe`를 직접 실행 → cmd 창 없이 바로 앱 창이 뜸).
아이콘/런처를 다시 만들 필요는 없음 — `node_modules`와 프로젝트 폴더만 유지하면 계속 동작.

## 파일 구조

- `main.js` — Electron 메인 프로세스. IPC 핸들러: `get-settings`, `save-settings`, `extract-table`, `export-pdf`, `print-now`
- `preload.js` — `window.api`로 위 IPC를 렌더러에 안전하게 노출 (contextIsolation 사용)
- `src/vlm.js` — OpenAI GPT-4o Vision 호출, 표를 `{ columns: [{header, lang}], rows: [[...]] }` JSON으로 추출하는 로직 + 프롬프트
- `renderer/index.html`, `style.css`, `renderer.js` — 3단계 UI (업로드 → 편집 → 미리보기)
- `launch.vbs` — 바탕화면 아이콘용 무창(無窓) 실행기
- `package.json` — `npm start`(개발 실행), `npm run dist`(electron-builder로 Windows 설치파일 빌드, 아직 실행 안 해봄 — 인터넷으로 빌드 리소스 다운로드 필요)

## API 키

- 설정(⚙) 모달에서 입력한 OpenAI API 키는 `%APPDATA%\table-ocr-print\settings.json`에 저장됨
- 사용자가 이미 실제 키를 입력해서 정상 저장되어 있는 상태

## 구현된 기능 (요청 반영 내역)

1. 이미지 업로드(드래그앤드롭/클릭) → GPT-4o Vision으로 표 인식 (원문 그대로, 열마다 en/ko/other 자동 분류)
2. 인식 중 단계별 진행률 표시줄 (준비 → 인코딩 → 전송 → AI 분석)
3. 편집 화면: 셀 텍스트 직접 수정(contenteditable), 열의 언어 분류 드롭다운 수정, 행 삭제
4. 미리보기 — **세로 A4, 1페이지에 표 1개**, 탭 2개만 존재:
   - **영어 전용**: 한글 열 제거 + 오른쪽에 "한글 뜻 쓰기" 빈 칸 추가 (시험용)
   - **한글 전용**: 영어 열 제거 + 오른쪽에 "English 쓰기" 빈 칸 추가 (시험용)
   - (초기에 있었던 "가로 2단 비교" 페이지는 사용자 요청으로 제거됨)
5. 각 탭에서 "🖨 인쇄"(webContents.print) 또는 "PDF로 저장"(printToPDF + 저장 다이얼로그) 가능

## 진행 중 해결한 버그

1. **바탕화면 아이콘 더블클릭해도 안 뜸** — `launch.vbs`에서 프로세스 창 스타일을 숨김(0)으로 실행해서 Electron 창 자체가 안 보였음 → 스타일을 1(정상 표시)로 수정
2. **설정 저장 버튼 눌러도 반응 없음처럼 보임** — 실제로는 저장이 됐지만 성공 여부를 알려주는 화면 표시가 없었음 → 저장 성공/실패 메시지(초록/빨강 박스) 추가
3. **저장 메시지는 뜨는데 설정 창이 안 닫힘** — `style.css`의 `.modal-backdrop { display: flex }` 규칙이 HTML `hidden` 속성의 기본 숨김 효과보다 우선순위가 높아서, JS가 `hidden = true`로 설정해도 실제로는 안 사라졌음 → `.modal-backdrop[hidden] { display: none; }` 규칙 추가로 해결 (실제 렌더링된 크기 0×0까지 확인 완료)

모든 수정 사항은 가짜 데이터로 업로드→인식→편집→미리보기 전체 흐름을 재현해서 렌더링 결과(HTML)까지 직접 확인함.

## 다음에 이어서 할 수 있는 것 (아직 안 한 것 / 제안)

- `npm run dist`로 실제 설치형 `.exe`(NSIS) 패키징 — 인터넷 필요, 아직 실행 안 함
- 앱 전용 아이콘(.ico) 지정 — 현재는 Electron 기본 아이콘 사용
- 한 장의 사진에 표가 여러 개 있는 경우 처리 (현재는 사진 1장 = 표 1개 가정)
- 편집 화면에서 행/열 추가 기능 (현재는 행 삭제만 가능)
- 인식 실패/재시도 UX 개선, OpenAI 모델 선택 옵션(gpt-4o 외) 등
