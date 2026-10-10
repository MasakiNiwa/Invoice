"""
インボイス確認ツール(Colab 版)のサーバー。

- GitHub Pages 版と同じ UI(ビルド済みの dist)を配信する
- 文字認識(PaddleOCR)を GPU/CPU で実行する API を提供する(/api/ocr)
- 起動ごとに自動生成するパスワードでログインした人だけが使える(Cookie のセッション)

起動: python -m invoice_server --dist /path/to/dist
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .ocr import PaddleOcr, Params

COOKIE = "invoice_session"
#: このアプリの画面だけが付けるヘッダー(他のサイトからの POST を防ぐ)
CLIENT_HEADER = "x-invoice-client"
SESSION_TTL = 12 * 3600
#: ログイン失敗の上限(IP ごと、10分あたり)
MAX_FAILS = 10
#: 1枚の画像の上限
MAX_UPLOAD = 40 * 1024 * 1024
MAX_PIXELS = 60_000_000

FRAME_ANCESTORS = "frame-ancestors 'self' https://colab.research.google.com https://*.googleusercontent.com https://*.colab.dev https://*.colab.googleusercontent.com"

LOGIN_HTML = """<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ログイン - インボイス確認ツール(Colab)</title>
<style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#cbd5e1;--accent:#0d9488}
@media (prefers-color-scheme:dark){:root{--bg:#020617;--card:#0f172a;--fg:#e2e8f0;--muted:#94a3b8;--line:#334155}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
form{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px;width:min(360px,calc(100vw - 32px));box-sizing:border-box}
h1{font-size:18px;margin:0 0 4px}p{color:var(--muted);font-size:13px;margin:0 0 18px;line-height:1.6}
input{width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{color:#e11d48;font-size:13px;min-height:18px;margin-top:10px}
</style></head><body>
<form id="f"><h1>インボイス確認ツール(Colab)</h1>
<p>Colab のノートブックに表示されたパスワードを入力してください。</p>
<input id="pw" type="password" autocomplete="current-password" placeholder="パスワード" autofocus required>
<button type="submit">ログイン</button><div class="err" id="err"></div></form>
<script>
const f=document.getElementById('f'),pw=document.getElementById('pw'),err=document.getElementById('err');
async function login(p){err.textContent='';const r=await fetch('api/login',{method:'POST',headers:{'content-type':'application/json','x-invoice-client':'1'},body:JSON.stringify({password:p})});
 const j=await r.json().catch(()=>({}));
 if(r.ok){try{localStorage.setItem('invoice-colab-token',j.token)}catch(e){}location.replace('./');return}
 err.textContent=j.detail||('ログインできませんでした('+r.status+')')}
f.onsubmit=e=>{e.preventDefault();login(pw.value)};
// ノートブックの「ワンクリックでログイン」リンク(#pw=...)。パスワードはサーバーへ送る前に URL から消す
// (埋め込み方によっては # が %23 としてパスに入るので、パスの方も見る)
const m=(location.hash+' '+decodeURIComponent(location.pathname)).match(/pw=([^&#\\s/]+)/);if(m){history.replaceState(null,'','login');login(decodeURIComponent(m[1]))}
</script></body></html>"""


def create_app(dist: str | Path, models: str | Path | None = None, password: str | None = None, device: str = "auto", version: str = "", debug_dir: str | Path | None = None, log=None) -> FastAPI:
    dist = Path(dist).resolve()
    models = Path(models).resolve() if models else dist / "paddle"
    # 記録の書き出し先(既定は標準出力。ノートブックの中で動かすときはファイルへ)
    log = log or (lambda msg: print(msg, flush=True))
    if not (dist / "index.html").exists():
        raise FileNotFoundError(f"UI が見つかりません: {dist}/index.html")
    password = password or secrets.token_urlsafe(9)
    secret = secrets.token_bytes(32)
    sessions: dict[str, float] = {}
    fails: dict[str, list[float]] = {}
    ocr = PaddleOcr(models, device=device)
    started = time.time()
    gpu_name = _gpu_name() if ocr.gpu else None
    debug = Path(debug_dir) if debug_dir else None
    if debug:
        debug.mkdir(parents=True, exist_ok=True)
    counter = {"n": 0}

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.password = password
    app.state.ocr = ocr

    def sign(sid: str) -> str:
        return sid + "." + hmac.new(secret, sid.encode(), hashlib.sha256).hexdigest()

    def valid(token: str | None) -> bool:
        if not token or "." not in token:
            return False
        sid, _ = token.rsplit(".", 1)
        if not hmac.compare_digest(sign(sid), token):
            return False
        exp = sessions.get(sid)
        return exp is not None and exp > time.time()

    def client_ip(req: Request) -> str:
        # Cloudflare のトンネル経由なら接続元は CF-Connecting-IP に入る
        return req.headers.get("cf-connecting-ip") or (req.client.host if req.client else "?")

    LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]", "testserver")

    def is_https(req: Request) -> bool:
        # Cloudflare・Colab のプロキシは https で中継する。転送ヘッダーが無かったり Host が localhost に
        # 書き換えられたりすることもあるので、ブラウザが付ける Origin も見る
        host = req.headers.get("host", "").split(":")[0]
        return (
            req.headers.get("x-forwarded-proto", req.url.scheme) == "https"
            or host not in LOCAL_HOSTS
            or req.headers.get("origin", "").startswith("https://")
        )

    def token_of(req: Request) -> str | None:
        # ブラウザが保存したトークン(Authorization ヘッダー)か Cookie。プロキシが Cookie を扱わない場合もあるので両方
        h = req.headers.get("authorization", "")
        return h[7:] if h.startswith("Bearer ") else req.cookies.get(COOKIE)

    @app.middleware("http")
    async def auth(req: Request, call_next):
        path = req.url.path
        # 画面のファイル(HTML・JS・モデル)は GitHub Pages で公開しているものと同じなので、そのまま配信する。
        # 守るのは API(文字認識など)
        if not path.startswith("/api/"):
            return await call_next(req)
        # 他のサイトからのリクエストの防止: POST にはこのアプリだけが付けるヘッダーを必須にする
        # (別のサイトの画面からこのヘッダーを付けて送るには事前の確認(CORS)が必要で、それには応じないため送れない)
        if req.method == "POST" and req.headers.get(CLIENT_HEADER) != "1":
            return JSONResponse({"detail": "このアプリ以外からのリクエストは受け付けません"}, status_code=403)
        if path == "/api/login":
            return await call_next(req)
        if valid(token_of(req)):
            res = await call_next(req)
            res.headers.setdefault("Cache-Control", "no-store")
            return res
        return JSONResponse({"app": "invoice-colab", "detail": "ログインが必要です", "login": "login"}, status_code=401)

    # 埋め込みは Colab のノートブックの中だけ許す(他のサイトに埋め込まれて操作されるのを防ぐ)
    @app.middleware("http")
    async def frame_policy(req: Request, call_next):
        res = await call_next(req)
        res.headers["Content-Security-Policy"] = FRAME_ANCESTORS
        return res

    # 受け付けたリクエストの記録(つながらないときの調査用。見張りの /healthz と画面の部品は除く)
    @app.middleware("http")
    async def access_log(req: Request, call_next):
        t0 = time.perf_counter()
        path = req.url.path
        try:
            res = await call_next(req)
        except Exception as e:
            log(f"[invoice] {req.method} {path} -> 例外 {type(e).__name__}: {e}")
            raise
        if path != "/healthz" and not path.startswith("/assets/"):
            log(f"[invoice] {req.method} {path} {res.status_code} {(time.perf_counter() - t0) * 1000:.0f}ms via {req.headers.get('host', '?')} from {req.client.host if req.client else '?'}")
        return res

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get("/login")
    @app.get("/login{rest:path}")
    def login_page(rest: str = ""):
        return HTMLResponse(LOGIN_HTML, headers={"Cache-Control": "no-store"})

    @app.post("/api/login")
    async def login(req: Request):
        ip = client_ip(req)
        now = time.time()
        recent = [t for t in fails.get(ip, []) if now - t < 600]
        if len(recent) >= MAX_FAILS:
            raise HTTPException(429, "失敗が続いたため、しばらく待ってから再度お試しください")
        try:
            body = await req.json()
        except Exception:
            body = {}
        given = str(body.get("password", ""))
        if not hmac.compare_digest(given.encode(), password.encode()):
            fails[ip] = recent + [now]
            raise HTTPException(401, "パスワードが違います")
        fails.pop(ip, None)
        sid = secrets.token_urlsafe(24)
        sessions[sid] = now + SESSION_TTL
        res = JSONResponse({"ok": True, "token": sign(sid)})
        if is_https(req):
            # ノートブックの中(Colab の出力枠 = 別サイトの iframe)でも使えるよう SameSite=None。
            # Partitioned で、その埋め込み先でだけ有効な Cookie にする
            res.headers.append("set-cookie", f"{COOKIE}={sign(sid)}; Max-Age={SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned")
        else:
            res.set_cookie(COOKIE, sign(sid), max_age=SESSION_TTL, httponly=True, samesite="lax")
        return res

    @app.post("/api/logout")
    def logout(req: Request):
        token = token_of(req)
        if token and "." in token:
            sessions.pop(token.rsplit(".", 1)[0], None)
        res = JSONResponse({"ok": True})
        res.delete_cookie(COOKIE)
        return res

    @app.get("/api/status")
    def status():
        return {
            "app": "invoice-colab",
            "version": version,
            "provider": ocr.provider,
            "gpu": gpu_name,
            "detProvider": ocr.det_provider,
            "recProvider": ocr.rec_provider,
            # 同時に送ってよい認識ジョブの数(ブラウザ側の並列数)
            "parallel": 6 if ocr.gpu else max(2, min(8, os.cpu_count() or 2)),
            "uptime": round(time.time() - started),
        }

    @app.post("/api/ocr")
    async def run_ocr(req: Request, psm: str = "3", detectOnly: int = 0, recPadY: float = 0, recPadX: float = 0, recStretch: float = 1):
        body = await req.body()
        if not body or len(body) > MAX_UPLOAD:
            raise HTTPException(413, "画像が大きすぎます")
        img = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(400, "画像を読み込めません")
        if img.shape[0] * img.shape[1] > MAX_PIXELS:
            raise HTTPException(413, "画像が大きすぎます")
        p = Params(psm=psm, detect_only=bool(detectOnly), rec_pad_y=recPadY, rec_pad_x=recPadX, rec_stretch=recStretch)
        t0 = time.perf_counter()
        result = await run_in_threadpool(ocr.recognize, img, p)
        ms = (time.perf_counter() - t0) * 1000
        if debug:
            # 開発用: 受け取った画像と結果を保存する(--debug-dir 指定時のみ)
            counter["n"] += 1
            stem = debug / f"{counter['n']:05d}_psm{psm}{'_det' if detectOnly else ''}"
            cv2.imwrite(str(stem) + ".png", img)
            stem.with_suffix(".json").write_text(json.dumps({"params": p.__dict__, "ms": round(ms), "text": result["text"]}, ensure_ascii=False), encoding="utf-8")
        return Response(json.dumps(result, ensure_ascii=False), media_type="application/json", headers={"Server-Timing": f"ocr;dur={ms:.0f}"})

    # ---- UI(ビルド済みのファイル。見つからないパスは index.html) ----
    @app.get("/{path:path}")
    def static(path: str):
        target = (dist / path).resolve()
        if path and target.is_file() and dist in target.parents:
            headers = {"Cache-Control": "public, max-age=31536000, immutable"} if path.startswith("assets/") else {}
            return FileResponse(target, headers=headers)
        return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})

    return app


def _gpu_name() -> str | None:
    try:
        import subprocess

        out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else "GPU"
    except Exception:
        return "GPU"
