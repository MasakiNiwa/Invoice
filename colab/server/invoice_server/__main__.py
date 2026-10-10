"""python -m invoice_server --dist ./dist [--port 8765] [--password ...]"""
import argparse
import json
import os
import sys

import uvicorn

from .app import create_app


def main() -> None:
    ap = argparse.ArgumentParser(description="インボイス確認ツール(Colab 版)のサーバー")
    ap.add_argument("--dist", required=True, help="ビルド済みの UI(index.html のあるフォルダ)")
    ap.add_argument("--models", help="PaddleOCR のモデル(det.ort/rec.onnx/dict.txt)。省略時は dist/paddle")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--password", default=os.environ.get("INVOICE_PASSWORD"), help="省略時は自動生成")
    ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
    ap.add_argument("--debug-dir", help="開発用: 受け取った画像と認識結果を保存するフォルダ")
    ap.add_argument("--info", help="起動情報(パスワード等)を書き出す JSON ファイル")
    a = ap.parse_args()

    version = ""
    try:
        version = json.load(open(os.path.join(a.dist, "version.json"), encoding="utf-8")).get("version", "")
    except Exception:
        pass
    app = create_app(a.dist, a.models, a.password, a.device, version, a.debug_dir)
    info = {"password": app.state.password, "port": a.port, "provider": app.state.ocr.provider, "version": version}
    if a.info:
        with open(a.info, "w", encoding="utf-8") as f:
            json.dump(info, f)
        os.chmod(a.info, 0o600)
    print(f"[invoice] OCR: {app.state.ocr.provider} (det={app.state.ocr.det_provider}, rec={app.state.ocr.rec_provider})", flush=True)
    print(f"[invoice] http://{a.host}:{a.port}/", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning", proxy_headers=True, forwarded_allow_ips="127.0.0.1")


if __name__ == "__main__":
    sys.exit(main())
