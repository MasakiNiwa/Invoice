"""python -m invoice_server --dist ./dist [--port 8765] [--password ...]"""
import argparse
import json
import os
import socket
import sys

import uvicorn

from .app import create_app


def main() -> None:
    ap = argparse.ArgumentParser(description="インボイス確認ツール(Colab 版)のサーバー")
    ap.add_argument("--dist", required=True, help="ビルド済みの UI(index.html のあるフォルダ)")
    ap.add_argument("--models", help="PaddleOCR のモデル(det.ort/rec.onnx/dict.txt)。省略時は dist/paddle")
    ap.add_argument("--host", default="127.0.0.1", help="dual = IPv4 と IPv6 の両方で待ち受け(Colab のプロキシ用)")
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
    sockets = _sockets(a.host, a.port)
    print(f"[invoice] listening: {', '.join(f'{s.getsockname()[0]}:{a.port}' for s in sockets)}", flush=True)
    config = uvicorn.Config(app, log_level="warning", proxy_headers=True, forwarded_allow_ips="127.0.0.1,::1")
    uvicorn.Server(config).run(sockets=sockets)


def _sockets(host: str, port: int) -> list[socket.socket]:
    """待ち受けるソケット。dual のときは IPv6(IPv4 も受ける)を試し、IPv6 が無い環境では IPv4 だけ"""
    if host == "dual":
        try:
            s6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            s6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            s6.bind(("::", port))
            return [s6]
        except OSError:
            host = "0.0.0.0"
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port))
    return [s]


if __name__ == "__main__":
    sys.exit(main())
