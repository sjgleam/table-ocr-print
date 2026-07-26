"""PaddleOCR table extraction helper.

Invoked by the Electron main process as: python paddle_table.py <image-path>
Always prints exactly one single-line JSON object to stdout as its final line:
  {"cells": [["r0c0", "r0c1", ...], ...]}  on success
  {"error": "human-readable message"}      on failure
ensure_ascii keeps the line ASCII-only so Windows console codepages (cp949)
can never corrupt it; PaddleOCR's own logs may precede it on stdout/stderr,
so the Node side reads the LAST line that starts with "{".
"""
import json
import os
import shutil
import sys
import tempfile
from html.parser import HTMLParser

# Recognition accuracy tracks how tall the glyphs are in pixels, and these
# word tables pack 20+ rows into the frame. On the 653x736 reference sample
# (~12px glyphs) recognition was ~68% correct; upscaling to a ~2200px long
# side (~36px glyphs) took it to ~93% on the same image, fixing errors like
# live->"1ve", food->"fod" and several fully garbled rows. Phone photos are
# already larger than the target, so they're left alone.
TARGET_LONG_SIDE = 2200
MAX_UPSCALE = 3.0
# Keep detection from shrinking the (now large) image back down, while still
# capping very large photos so inference stays bounded.
DET_LIMIT_SIDE_LEN = 2400


def emit(obj):
    sys.stdout.write("\n" + json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def describe_exception(err):
    """Flatten an exception's cause chain into one message.

    PaddleOCR wraps the actionable error inside a generic one -- a missing
    table-pipeline extra surfaces as "A dependency error occurred during
    pipeline creation", while only the inner DependencyError names the fix
    (pip install "paddlex[ocr]"). Reporting just the outermost message would
    leave the user with nothing to act on.
    """
    parts = []
    seen = set()
    cur = err
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        text = " ".join(str(cur).split())
        if text and text not in parts:
            parts.append(text)
        cur = cur.__cause__ or cur.__context__
    return " / 원인: ".join(parts) if parts else type(err).__name__


class TableGridParser(HTMLParser):
    """Turns PP-Structure's predicted <table> HTML into a 2D string grid.

    colspan is expanded with empty trailing cells so row widths stay aligned;
    rowspan is ignored (word-list tables don't use it).
    """

    def __init__(self):
        super().__init__()
        self.rows = []
        self._row = None
        self._cell = None
        self._colspan = 1

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []
            self._colspan = 1
            for name, value in attrs:
                if name == "colspan":
                    try:
                        self._colspan = max(1, int(value))
                    except (TypeError, ValueError):
                        pass

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._cell is not None:
            self._row.append("".join(self._cell).strip())
            self._row.extend([""] * (self._colspan - 1))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def grid_from_html(html):
    parser = TableGridParser()
    parser.feed(html)
    rows = [r for r in parser.rows if any(c.strip() for c in r)]
    if not rows:
        return None
    width = max(len(r) for r in rows)
    return [r + [""] * (width - len(r)) for r in rows]


def prepare_image(image_path, out_dir=None):
    """Upscale a small image so its glyphs are big enough to recognize.

    Returns the path to use (the original when it's already large enough, or
    Pillow is unavailable, or anything goes wrong — a failed upscale should
    degrade accuracy, never the run). The resized copy goes to out_dir when
    given; otherwise beside the input. Callers that don't own the input's
    directory should pass out_dir, or running this on someone's photo folder
    leaves an "upscaled-input.png" behind.
    """
    try:
        from PIL import Image
    except ImportError:
        return image_path

    try:
        with Image.open(image_path) as im:
            long_side = max(im.size)
            if long_side <= 0:
                return image_path
            scale = min(TARGET_LONG_SIDE / long_side, MAX_UPSCALE)
            if scale <= 1.0:
                return image_path
            resized = im.resize(
                (round(im.width * scale), round(im.height * scale)), Image.LANCZOS
            )
            out = os.path.join(
                out_dir or os.path.dirname(image_path) or ".", "upscaled-input.png"
            )
            resized.save(out)
            return out
    except Exception:  # noqa: BLE001 - keep the original image on any failure
        return image_path


def tables_via_v3(image_path):
    """PaddleOCR >= 3.0: PPStructureV3 pipeline."""
    from paddleocr import PPStructureV3

    # lang="korean" picks the Korean recognition model (these tables mix
    # ko/en). enable_mkldnn=False is required, not an optimization: with
    # oneDNN on, paddle 3.3.1 aborts mid-inference with "NotImplementedError:
    # ConvertPirAttribute2RuntimeAttribute not support
    # [pir::ArrayAttribute<pir::DoubleAttribute>]".
    #
    # use_textline_orientation=False matters just as much. On short table
    # cells the orientation classifier frequently decides a line is upside
    # down and recognizes it rotated 180 degrees, so scattered cells come
    # back as mojibake while their neighbours are perfect ("amazing" ->
    # "buzeue", "cloud" -> "pno", "12" -> "Z1"). Table cells are never
    # rotated in a photographed word list, so the classifier can only lose
    # here: switching it off took one benchmark image from 47% to 100%.
    #
    # The seal/formula/chart sub-pipelines are off since word tables never
    # need them, which also avoids downloading their models. Each fallback
    # drops the options a given PaddleOCR build might not accept.
    attempts = [
        {
            "lang": "korean",
            "enable_mkldnn": False,
            "text_det_limit_side_len": DET_LIMIT_SIDE_LEN,
            "text_det_limit_type": "max",
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "use_seal_recognition": False,
            "use_formula_recognition": False,
            "use_chart_recognition": False,
        },
        {"lang": "korean", "enable_mkldnn": False, "use_textline_orientation": False},
        {"enable_mkldnn": False, "use_textline_orientation": False},
        {"enable_mkldnn": False},
        {},
    ]
    pipeline = None
    last_err = None
    for kwargs in attempts:
        try:
            pipeline = PPStructureV3(**kwargs)
            break
        except Exception as err:  # noqa: BLE001 - fall through to next config
            last_err = err
    if pipeline is None:
        raise RuntimeError("PPStructureV3 init failed: %s" % describe_exception(last_err))

    htmls = []
    for res in pipeline.predict(image_path):
        data = getattr(res, "json", None)
        if isinstance(data, dict):
            data = data.get("res", data)
        elif isinstance(res, dict):
            data = res
        if not isinstance(data, dict):
            continue
        for table in data.get("table_res_list") or []:
            html = table.get("pred_html") if isinstance(table, dict) else None
            if html:
                htmls.append(html)
    return htmls


def tables_via_v2(image_path):
    """PaddleOCR 2.x: PPStructure engine."""
    from paddleocr import PPStructure
    import cv2

    engine = None
    last_err = None
    for kwargs in ({"show_log": False, "lang": "korean"}, {"show_log": False}, {}):
        try:
            engine = PPStructure(**kwargs)
            break
        except Exception as err:  # noqa: BLE001
            last_err = err
    if engine is None:
        raise RuntimeError("PPStructure init failed: %s" % describe_exception(last_err))

    img = cv2.imread(image_path)
    if img is None:
        raise RuntimeError("cannot read image: %s" % image_path)

    htmls = []
    for region in engine(img):
        if isinstance(region, dict) and region.get("type") == "table":
            html = (region.get("res") or {}).get("html")
            if html:
                htmls.append(html)
    return htmls


def merge_grids(grids):
    """Multiple detected tables of the same width are treated as one table
    split into side-by-side blocks (the layout the sample photos use) and are
    stacked vertically; a repeated header row on later blocks is dropped.
    Otherwise the largest table wins."""
    if len(grids) == 1:
        return grids[0]
    width = len(grids[0][0])
    if all(len(g[0]) == width for g in grids):
        merged = list(grids[0])
        for grid in grids[1:]:
            merged.extend(grid[1:] if grid[0] == grids[0][0] else grid)
        return merged
    return max(grids, key=lambda g: len(g) * len(g[0]))


def main():
    if len(sys.argv) < 2:
        emit({"error": "usage: paddle_table.py <image-path>"})
        return

    # Own a scratch directory for the upscaled copy so nothing is written
    # next to the caller's image, and remove it however we exit.
    scratch = tempfile.mkdtemp(prefix="paddle-table-")
    try:
        image_path = prepare_image(sys.argv[1], out_dir=scratch)
        try:
            htmls = tables_via_v3(image_path)
        except ImportError:
            htmls = tables_via_v2(image_path)

        grids = [g for g in (grid_from_html(h) for h in htmls) if g]
        if not grids:
            emit({"error": "이미지에서 표를 찾지 못했습니다. 표가 선명하게 나온 사진인지 확인해주세요."})
            return
        emit({"cells": merge_grids(grids)})
    except ImportError as err:
        emit({
            "error": "PaddleOCR가 설치되어 있지 않습니다. 'pip install paddlepaddle \"paddleocr[doc-parser]\"' 실행 후 다시 시도해주세요. (%s)" % err
        })
    except Exception as err:  # noqa: BLE001 - anything else becomes a user-facing message
        emit({"error": "%s: %s" % (type(err).__name__, describe_exception(err))})
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
