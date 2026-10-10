"""
PaddleOCR (PP-OCRv5) の推論本体(サーバー版)。

ブラウザ版 src/lib/ocr/paddle-core.ts と同じ前処理・後処理で、同じ形の結果を返す。
ONNX Runtime の CUDA(GPU)が使えれば GPU、なければ CPU で動く。
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

REC_H = 48
DET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
DET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


@dataclass
class Params:
    psm: str = "3"
    detect_only: bool = False
    rec_pad_y: float = 0.0
    rec_pad_x: float = 0.0
    rec_stretch: float = 1.0


def _rect(x: float, y: float, w: float, h: float) -> dict:
    return {"x": float(x), "y": float(y), "w": float(w), "h": float(h)}


def _line(text: str, conf: float, rect: dict, symbols: list) -> dict:
    return {"text": text, "conf": conf, "rect": rect, "words": [{"text": text, "conf": conf, "rect": rect, "symbols": symbols}]}


def _resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    """縮小は面積平均、拡大は線形補間(ブラウザの drawImage に近い見え方)"""
    shrink = w < img.shape[1] or h < img.shape[0]
    return cv2.resize(img, (max(1, w), max(1, h)), interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR)


def pad_rect(r: dict, all_rects: list[dict], W: int, H: int, py: float, px: float) -> dict:
    """認識用に検出枠を広げる(隣の枠までの隙間の45%まで)。paddle-core.ts の padRect と同じ"""
    up, down, left, right = r["y"], H - (r["y"] + r["h"]), r["x"], W - (r["x"] + r["w"])
    for o in all_rects:
        if o is r:
            continue
        x_ov = min(r["x"] + r["w"], o["x"] + o["w"]) - max(r["x"], o["x"])
        y_ov = min(r["y"] + r["h"], o["y"] + o["h"]) - max(r["y"], o["y"])
        if x_ov > 0:
            if o["y"] + o["h"] <= r["y"]:
                up = min(up, r["y"] - (o["y"] + o["h"]))
            elif o["y"] >= r["y"] + r["h"]:
                down = min(down, o["y"] - (r["y"] + r["h"]))
        if y_ov > min(r["h"], o["h"]) * 0.3:
            if o["x"] + o["w"] <= r["x"]:
                left = min(left, r["x"] - (o["x"] + o["w"]))
            elif o["x"] >= r["x"] + r["w"]:
                right = min(right, o["x"] - (r["x"] + r["w"]))
    pu, pd = min(r["h"] * py, up * 0.45), min(r["h"] * py, down * 0.45)
    pl, pr = min(r["h"] * px, left * 0.45), min(r["h"] * px, right * 0.45)
    x0, y0 = max(0.0, r["x"] - pl), max(0.0, r["y"] - pu)
    x1, y1 = min(W, r["x"] + r["w"] + pr), min(H, r["y"] + r["h"] + pd)
    return _rect(x0, y0, x1 - x0, y1 - y0)


class PaddleOcr:
    def __init__(self, model_dir: str | Path, device: str = "auto", rec_batch: int | None = None):
        model_dir = Path(model_dir)
        det_path = next((model_dir / n for n in ("det.onnx", "det.ort") if (model_dir / n).exists()), None)
        rec_path = model_dir / "rec.onnx"
        if det_path is None or not rec_path.exists():
            raise FileNotFoundError(f"モデルが見つかりません: {model_dir}")
        # pip で入れた CUDA/cuDNN のライブラリを先に読み込む(onnxruntime-gpu 1.21 以降)
        if hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls()
            except Exception:
                pass
        available = ort.get_available_providers()
        want_gpu = device in ("auto", "cuda") and "CUDAExecutionProvider" in available
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.log_severity_level = 3
        gpu = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        cpu = ["CPUExecutionProvider"]

        def create(path: Path, use_gpu: bool) -> ort.InferenceSession:
            return ort.InferenceSession(str(path), sess_options=so, providers=gpu if use_gpu else cpu)

        # 検出モデルは ORT 形式(CPU 向けに最適化済み)のことがあるので、GPU で作れなければ CPU で動かす
        try:
            self.det = create(det_path, want_gpu)
        except Exception:
            self.det = create(det_path, False)
        try:
            self.rec = create(rec_path, want_gpu)
        except Exception:
            self.rec = create(rec_path, False)
        self.det_provider = self.det.get_providers()[0]
        self.rec_provider = self.rec.get_providers()[0]
        self.gpu = "CUDA" in self.rec_provider or "CUDA" in self.det_provider
        self.rec_batch = rec_batch or (24 if self.gpu else 8)
        # 辞書: 出力クラス index i の文字 = 辞書ファイルの i 行目(0 は blank)
        self.dict = (model_dir / "dict.txt").read_text(encoding="utf-8").splitlines()
        self.det_in = self.det.get_inputs()[0].name
        self.rec_in = self.rec.get_inputs()[0].name
        # GPU は1枚のカードを取り合うので、同時に流す推論の数を絞る(CPU はスレッドで並列)
        self._gpu_lock = threading.Semaphore(2 if self.gpu else max(1, (os.cpu_count() or 2)))

    @property
    def provider(self) -> str:
        return "cuda" if self.gpu else "cpu"

    # ------------------------------------------------------------------ 認識の入口
    def recognize(self, img: np.ndarray, p: Params) -> dict:
        """img: BGR の画像(uint8)"""
        H, W = img.shape[:2]
        if p.psm in ("7", "8", "13"):
            full = _rect(0, 0, W, H)
            r = self._rec_batch(img, [full], p.rec_stretch)[0]
            return {"text": r["text"], "conf": r["conf"], "lines": [_line(r["text"], r["conf"], full, r["symbols"])] if r["text"] else []}
        max_side = 3200 if p.psm == "3" else 1600
        boxes = self.detect(img, max_side)
        if p.detect_only:
            return {"text": "", "conf": 0, "lines": [{**_line("", 0, b["rect"], []), "angle": b["angle"], "elongation": b["elongation"]} for b in boxes]}
        rects = [b["rect"] for b in boxes]
        order = sorted(range(len(rects)), key=lambda i: rects[i]["w"] / max(1.0, rects[i]["h"]))
        lines = []
        B = self.rec_batch
        for i in range(0, len(order), B):
            batch = [rects[k] for k in order[i : i + B]]
            crops = [pad_rect(b, rects, W, H, p.rec_pad_y, p.rec_pad_x) for b in batch]
            for b, r in zip(batch, self._rec_batch(img, crops)):
                if r["text"].strip():
                    lines.append(_line(r["text"], r["conf"], b, r["symbols"]))
        lines.sort(key=lambda l: (l["rect"]["y"], l["rect"]["x"]))
        conf = sum(l["conf"] for l in lines) / len(lines) if lines else 0
        return {"text": "\n".join(l["text"] for l in lines), "conf": conf, "lines": lines}

    # ------------------------------------------------------------------ 検出(DBNet)
    def detect(self, img: np.ndarray, max_side: int) -> list[dict]:
        H, W = img.shape[:2]
        ratio = min(1.0, max_side / max(W, H))
        w = max(32, int(round(W * ratio / 32)) * 32)
        h = max(32, int(round(H * ratio / 32)) * 32)
        x = _resize(img, w, h).astype(np.float32) / 255.0
        # BGR 順のまま ImageNet の平均・分散で正規化(PaddleOCR と同じ)
        x = ((x - DET_MEAN) / DET_STD).transpose(2, 0, 1)[None]
        with self._gpu_lock:
            prob = self.det.run(None, {self.det_in: np.ascontiguousarray(x)})[0][0, 0]
        mask = prob > 0.3
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
        sx, sy = W / w, H / h
        out = []
        for i in range(1, n):
            cx, cy, cw, ch = (int(v) for v in stats[i, :4])
            if cw < 3 or ch < 3:
                continue
            sub = prob[cy : cy + ch, cx : cx + cw]
            m = sub > 0.3
            cnt = int(m.sum())
            if cnt == 0 or float(sub[m].mean()) < 0.6:
                continue
            ys, xs = np.nonzero(m)
            xs = xs.astype(np.float64) + cx
            ys = ys.astype(np.float64) + cy
            mx, my = xs.mean(), ys.mean()
            cxx = (xs * xs).mean() - mx * mx
            cyy = (ys * ys).mean() - my * my
            cxy = (xs * ys).mean() - mx * my
            angle = 0.5 * np.degrees(np.arctan2(2 * cxy, cxx - cyy))
            root = np.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy)
            l1, l2 = (cxx + cyy) / 2 + root, (cxx + cyy) / 2 - root
            elong = float(np.sqrt(l1 / max(1e-6, l2)))
            # unclip: 面積×1.5/周長 だけ外側に広げる(DB は縮めた領域を予測するため)
            d = cw * ch * 1.5 / (2 * (cw + ch))
            x0, y0 = max(0.0, (cx - d) * sx), max(0.0, (cy - d) * sy)
            x1, y1 = min(W, (cx + cw + d) * sx), min(H, (cy + ch + d) * sy)
            out.append({"rect": _rect(x0, y0, x1 - x0, y1 - y0), "angle": float(angle), "elongation": elong})
        return out

    # ------------------------------------------------------------------ 認識(CTC)
    def _rec_batch(self, img: np.ndarray, rects: list[dict], stretch: float = 1.0) -> list[dict]:
        if not rects:
            return []
        H, W = img.shape[:2]
        widths = [min(3200, max(16, int(round(r["w"] * REC_H / max(1.0, r["h"]) * stretch)))) for r in rects]
        Wmax = max(widths)
        x = np.zeros((len(rects), 3, REC_H, Wmax), dtype=np.float32)  # 0 = 正規化後の中間灰色でパディング
        for n, (r, w) in enumerate(zip(rects, widths)):
            x0, y0 = max(0, int(np.floor(r["x"]))), max(0, int(np.floor(r["y"])))
            x1, y1 = min(W, int(np.ceil(r["x"] + r["w"]))), min(H, int(np.ceil(r["y"] + r["h"])))
            crop = img[y0:max(y0 + 1, y1), x0:max(x0 + 1, x1)]
            line = _resize(crop, w, REC_H).astype(np.float32) / 127.5 - 1.0
            x[n, :, :, :w] = line.transpose(2, 0, 1)
        with self._gpu_lock:
            out = self.rec.run(None, {self.rec_in: x})[0]
        _, T, _ = out.shape
        best = out.argmax(axis=2)
        bestv = out.max(axis=2)
        res = []
        for n, r in enumerate(rects):
            Tn = max(1, int(round(T * widths[n] / Wmax)))
            step = r["w"] / Tn
            text, confs, symbols, last = "", [], [], 0
            for t in range(Tn):
                bi = int(best[n, t])
                if bi != 0 and bi != last:
                    ch = self.dict[bi] if bi < len(self.dict) else ""
                    v = float(bestv[n, t])
                    text += ch
                    confs.append(v)
                    symbols.append({"text": ch, "conf": v * 100, "rect": _rect(r["x"] + t * step, r["y"], step, r["h"])})
                last = bi
            res.append({"text": text, "conf": (sum(confs) / len(confs)) * 100 if confs else 0, "symbols": symbols})
        return res
