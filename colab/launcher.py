"""
インボイス確認ツール(Colab 版)の起動補助。ノートブック(Invoice_Colab.ipynb)から使う。

    import launcher
    launcher.setup(source="pages")   # UI とサーバーの準備
    launcher.start()                 # サーバーと公開リンク(Cloudflare)を起動し、リンクとパスワードを表示
    launcher.stop()                  # 停止

source:
  "pages"     … GitHub Pages で公開中のビルド済み UI(colab/app.zip)をダウンロードして使う(速い)
  "pages-dev" … GitHub Pages の開発版(dev ブランチ、/dev/colab/app.zip)を使う
  "build"     … このリポジトリ(ブランチ)のソースから UI をビルドする(push 前の版を試すとき)
"""
from __future__ import annotations

import html
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parents[1]
SERVER_DIR = REPO_DIR / "colab" / "server"
WORK = Path(os.environ.get("INVOICE_WORK", "/content" if Path("/content").exists() else Path.home() / "invoice-colab"))
APP_DIR = WORK / "invoice-app"
LOG_DIR = WORK / "logs"
PAGES_ZIP = "https://masakiniwa.github.io/Invoice/colab/app.zip"
#: dev ブランチの開発版(GitHub Pages の /dev/)
PAGES_DEV_ZIP = "https://masakiniwa.github.io/Invoice/dev/colab/app.zip"
NODE_VERSION = "v22.12.0"
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"

_procs: dict[str, subprocess.Popen] = {}
_state: dict[str, object] = {}


def _run(cmd: list[str] | str, **kw) -> None:
    print("$", cmd if isinstance(cmd, str) else " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, shell=isinstance(cmd, str), **kw)


def _download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"ダウンロード: {url}", flush=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)
    tmp.replace(dest)
    return dest


def has_gpu() -> bool:
    return shutil.which("nvidia-smi") is not None and subprocess.run(["nvidia-smi", "-L"], capture_output=True).returncode == 0


# --------------------------------------------------------------------------- 準備
def setup(source: str = "pages", install: bool = True) -> Path:
    """依存パッケージを入れ、UI(ビルド済みのファイル)を用意する。UI のフォルダを返す"""
    WORK.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if install:
        _install_python(has_gpu())
    if source == "pages":
        _ui_from_pages(PAGES_ZIP)
    elif source == "pages-dev":
        _ui_from_pages(PAGES_DEV_ZIP)
    elif source == "build":
        _ui_from_source()
    else:
        raise ValueError('source は "pages" / "pages-dev" / "build" のどれかを指定してください')
    v = _ui_version()
    print(f"UI の準備ができました: {APP_DIR}(v{v.get('version', '?')} {v.get('commit', '')})", flush=True)
    return APP_DIR


def _install_python(gpu: bool) -> None:
    req = SERVER_DIR / "requirements.txt"
    pkgs = [l.split("#")[0].strip() for l in req.read_text(encoding="utf-8").splitlines()]
    pkgs = [p for p in pkgs if p]
    if gpu:
        # GPU 版は CPU 版と同時に入っていると衝突するので入れ替える
        pkgs = [p for p in pkgs if not p.startswith("onnxruntime")] + ["onnxruntime-gpu>=1.20"]
        subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", "onnxruntime"], capture_output=True)
    _run([sys.executable, "-m", "pip", "install", "-q", *pkgs])


def _ui_from_pages(url: str) -> None:
    z = _download(url, WORK / "app.zip")
    if APP_DIR.exists():
        shutil.rmtree(APP_DIR)
    with zipfile.ZipFile(z) as f:
        f.extractall(APP_DIR)


def _node_bin() -> Path | None:
    """Node.js 22 以上(Vite のビルドに必要)。無ければダウンロードして使う"""
    node = shutil.which("node")
    if node:
        out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
        m = re.match(r"v(\d+)\.(\d+)", out)
        if m and (int(m[1]) > 22 or (int(m[1]) == 22 and int(m[2]) >= 12)):
            return Path(node).parent
    base = WORK / f"node-{NODE_VERSION}-linux-x64"
    if not (base / "bin" / "node").exists():
        tar = _download(f"https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-linux-x64.tar.xz", WORK / "node.tar.xz")
        with tarfile.open(tar) as t:
            try:
                t.extractall(WORK, filter="data")
            except TypeError:  # Python 3.11 以前
                t.extractall(WORK)
    return base / "bin"


def _ui_from_source() -> None:
    env = dict(os.environ)
    node = _node_bin()
    if node:
        env["PATH"] = f"{node}:{env['PATH']}"
    _run(["npm", "ci", "--no-audit", "--no-fund"], cwd=REPO_DIR, env=env)
    _run(["npm", "run", "build"], cwd=REPO_DIR, env=env)
    if APP_DIR.exists():
        shutil.rmtree(APP_DIR)
    shutil.copytree(REPO_DIR / "dist", APP_DIR)


def _ui_version() -> dict:
    try:
        return json.loads((APP_DIR / "version.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


# --------------------------------------------------------------------------- 起動
IN_COLAB = "COLAB_RELEASE_TAG" in os.environ or Path("/content").is_dir() and Path("/opt/google").is_dir()


def start(port: int = 8765, tunnel: bool = True, password: str | None = None, show: bool = True, watch: bool = True) -> dict:
    """サーバーと公開リンクを起動し、つながることを確かめてからリンクとパスワードを表示する。

    watch=True のとき、裏で数秒ごとに見張り、サーバーやトンネルが止まったら自動で起動し直す。
    """
    stop(quiet=True)
    if not (APP_DIR / "index.html").exists():
        raise RuntimeError("先に setup() を実行してください")
    password = password or secrets.token_urlsafe(9)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _launch_server(port, password)
    info = {"port": port, "password": password, "local": f"http://127.0.0.1:{port}/", "public": None, "colab": None, "tunnel": tunnel}
    info["engine"] = _server_line(LOG_DIR / "server.log")
    _state.clear()
    _state.update(info)
    if tunnel:
        info["public"] = _start_tunnel(port)
        _state["public"] = info["public"]
    info["colab"] = _colab_proxy_url(port)
    _state["colab"] = info["colab"]
    if show:
        display_links(info)
    if watch:
        _start_watchdog()
    return info


def _launch_server(port: int, password: str) -> None:
    env = dict(os.environ, INVOICE_PASSWORD=password, PYTHONPATH=str(SERVER_DIR))
    log = open(LOG_DIR / "server.log", "a")
    # Colab 内のリンク(Colab のプロキシ)からも届くよう、Colab では IPv4 と IPv6 の両方で待ち受ける
    # (プロキシは localhost に接続し、localhost が IPv6 の ::1 になることがある。
    #  Colab の VM は外から直接は届かない。届いてもパスワードが無ければ使えない)
    host = "dual" if IN_COLAB else "127.0.0.1"
    _procs["server"] = subprocess.Popen(
        [sys.executable, "-m", "invoice_server", "--dist", str(APP_DIR), "--host", host, "--port", str(port)],
        cwd=SERVER_DIR, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    _wait_http(f"http://127.0.0.1:{port}/healthz", _procs["server"], LOG_DIR / "server.log")


def _wait_http(url: str, proc: subprocess.Popen, logfile: Path, timeout: float = 180) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None:
            raise RuntimeError("サーバーが起動できませんでした:\n" + logfile.read_text(encoding="utf-8", errors="replace")[-3000:])
        if _http_ok(url):
            return
        time.sleep(0.5)
    raise TimeoutError("サーバーの起動がタイムアウトしました")


def _http_ok(url: str, timeout: float = 5) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _server_line(logfile: Path) -> str:
    for line in logfile.read_text(encoding="utf-8", errors="replace").splitlines()[::-1]:
        if line.startswith("[invoice] OCR:"):
            return line.replace("[invoice] ", "")
    return ""


#: 発行されたリンクは「単語-単語-…」の形(エラー文中の api.trycloudflare.com は除く)
_TUNNEL_RE = re.compile(r"https://(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com")


def _start_tunnel(port: int) -> str | None:
    """Cloudflare のクイックトンネル(アカウント不要)で https の公開リンクを作る。

    リンクが発行されても、トンネルの接続が確立するまでは Error 1033 になるので、
    実際にリンク経由でサーバーへ届くことを確かめてから返す。つながらなければ通信方式を変えて作り直す。
    """
    exe = WORK / "cloudflared"
    if not exe.exists():
        _download(CLOUDFLARED_URL, exe)
        exe.chmod(0o755)
    for attempt, protocol in enumerate(("auto", "http2", "http2")):
        url = _launch_tunnel(exe, port, protocol)
        if not url:
            print(f"公開リンクを発行できませんでした(試行 {attempt + 1}/3)。作り直します…", flush=True)
            continue
        print(f"公開リンクを発行しました。つながるか確認しています…(最大60秒) {url}", flush=True)
        t0 = time.time()
        while time.time() - t0 < 60:
            if _procs["tunnel"].poll() is not None:
                break
            if _http_ok(url + "/healthz", timeout=8):
                print("公開リンクの接続を確認しました", flush=True)
                return url
            time.sleep(2)
        print(f"公開リンクにつながりませんでした(試行 {attempt + 1}/3、方式 {protocol})。作り直します…", flush=True)
    print("Cloudflare の公開リンクを作れませんでした。Colab 内のリンクを使ってください。ログ: launcher.logs('cloudflared')", flush=True)
    return None


def _launch_tunnel(exe: Path, port: int, protocol: str) -> str | None:
    p = _procs.pop("tunnel", None)
    if p and p.poll() is None:
        p.terminate()
    logfile = LOG_DIR / "cloudflared.log"
    log = open(logfile, "w")
    cmd = [str(exe), "tunnel", "--no-autoupdate", "--protocol", protocol, "--url", f"http://127.0.0.1:{port}"]
    _procs["tunnel"] = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    t0 = time.time()
    while time.time() - t0 < 45:
        text = logfile.read_text(encoding="utf-8", errors="replace")
        m = _TUNNEL_RE.search(text)
        if m:
            return m.group(0)
        if _procs["tunnel"].poll() is not None:
            return None
        time.sleep(0.5)
    return None


# --------------------------------------------------------------------------- 見張り(自動で起動し直す)
_watch: dict[str, object] = {}


def _note(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    with open(LOG_DIR / "monitor.log", "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)


def _start_watchdog() -> None:
    import threading

    stop_ev = threading.Event()
    _watch["stop"] = stop_ev

    def loop() -> None:
        fails = 0
        while not stop_ev.wait(10):
            port = int(_state["port"])
            server = _procs.get("server")
            ok = server is not None and server.poll() is None and _http_ok(f"http://127.0.0.1:{port}/healthz")
            fails = 0 if ok else fails + 1
            if fails >= 2:
                _note("サーバーが止まっていたので起動し直します(パスワードは同じです)")
                try:
                    p = _procs.pop("server", None)
                    if p and p.poll() is None:
                        p.kill()
                    _launch_server(port, str(_state["password"]))
                    fails = 0
                except Exception as e:
                    _note(f"サーバーを起動し直せませんでした: {e}")
            tunnel = _procs.get("tunnel")
            if _state.get("tunnel") and _state.get("public") and (tunnel is None or tunnel.poll() is not None):
                _note("公開リンクが切れたので作り直します(リンクが変わります)")
                url = _start_tunnel(port)
                _state["public"] = url
                if url:
                    _note(f"新しい公開リンク: {url}/login")

    t = threading.Thread(target=loop, name="invoice-watchdog", daemon=True)
    _watch["thread"] = t
    t.start()


def diagnose() -> None:
    """うまく開けないときの確認(この結果を共有してもらえると原因を特定しやすい。パスワードは表示しません)"""
    port = int(_state.get("port", 8765))
    server = _procs.get("server")
    tunnel = _procs.get("tunnel")
    print("Colab:", IN_COLAB, "/ GPU:", has_gpu(), "/ UI:", _ui_version().get("version", "?"))
    print("サーバーのプロセス:", "動作中" if server and server.poll() is None else f"停止(終了コード {server.poll() if server else '-'})")
    for h in ("127.0.0.1", "localhost", "[::1]"):
        print(f"サーバーの応答({h}):", "OK" if _http_ok(f"http://{h}:{port}/healthz", timeout=3) else "応答なし")
    print("トンネルのプロセス:", "動作中" if tunnel and tunnel.poll() is None else ("停止" if tunnel else "なし"))
    if _state.get("public"):
        print("公開リンクの応答:", "OK" if _http_ok(str(_state["public"]) + "/healthz", timeout=10) else "応答なし", _state["public"])
    print("Colab 内のリンク:", _state.get("colab") or "なし")
    for name in ("monitor", "server", "cloudflared"):
        print(f"\n----- {name}.log(最後の部分)-----")
        logs(name, tail=25)


def _colab_proxy_url(port: int) -> str | None:
    """Colab のプロキシ経由のリンク(このノートブックを開いている Google アカウントのブラウザでのみ開ける)"""
    try:
        from google.colab.output import eval_js  # type: ignore

        return eval_js(f"google.colab.kernel.proxyPort({port})")
    except Exception:
        return None


def display_links(info: dict | None = None) -> None:
    info = info or dict(_state)
    pw = html.escape(str(info["password"]))
    rows = []
    if info.get("public"):
        url = html.escape(str(info["public"]))
        rows.append(f'<a href="{url}/login" target="_blank" style="{_BTN}">アプリを開く(公開リンク)</a>'
                    f'<div style="margin:6px 0 2px;color:#64748b;font-size:12px">{url}</div>')
        rows.append(f'<div style="font-size:12px;margin-top:4px">ワンクリックでログイン: <a href="{url}/login#pw={pw}" target="_blank">{url}/login#pw=…</a>'
                    '<span style="color:#64748b">(パスワード入りのリンクです。人に送らないでください)</span></div>')
    if info.get("colab"):
        cu = html.escape(str(info["colab"]).rstrip("/"))
        rows.append(f'<a href="{cu}/login#pw={pw}" target="_blank" style="{_BTN};background:#7c3aed;margin-top:8px">アプリを開く(Colab 内のリンク)</a>'
                    '<div style="margin:4px 0 2px;color:#64748b;font-size:12px">このノートブックを開いている Google アカウントのブラウザでだけ開けます</div>')
    if info.get("colab"):
        rows.append('<div style="margin-top:6px;font-size:12px;color:#64748b">開けないときは、このセルの下に出る Colab のリンク(「アプリを開く(Colab)」)もお試しください</div>')
    body = "".join(rows) or f'<div>公開リンクはありません。ローカル: {html.escape(info["local"])}</div>'
    out = f"""<div style="font-family:system-ui,sans-serif;border:1px solid #cbd5e1;border-radius:12px;padding:14px 16px;max-width:640px">
<div style="font-weight:700;margin-bottom:8px">インボイス確認ツール(Colab)を起動しました</div>{body}
<div style="margin-top:10px">パスワード: <code style="font-size:15px;background:#f1f5f9;color:#0f172a;padding:2px 8px;border-radius:6px">{pw}</code>
<button onclick="navigator.clipboard.writeText('{pw}');this.textContent='コピーしました'" style="margin-left:6px">コピー</button></div>
<div style="margin-top:6px;color:#64748b;font-size:12px">{html.escape(info.get('engine') or '')}。このセルの実行を止めるかランタイムを切断すると、リンクは使えなくなります。</div></div>"""
    try:
        from IPython.display import HTML, display  # type: ignore

        display(HTML(out))
        if info.get("colab"):
            # Colab 公式の開き方(Colab の画面から認証付きで新しいタブを開く)
            try:
                from google.colab import output  # type: ignore

                output.serve_kernel_port_as_window(int(info["port"]), path="/login", anchor_text="アプリを開く(Colab)")
            except Exception:
                pass
    except Exception:
        print(json.dumps(info, ensure_ascii=False, indent=2))


_BTN = "display:inline-block;background:#0d9488;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600"


def stop(quiet: bool = False) -> None:
    ev = _watch.pop("stop", None)
    if ev:
        ev.set()  # type: ignore[attr-defined]
    for name in ("tunnel", "server"):
        p = _procs.pop(name, None)
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.kill()
    if not quiet:
        print("停止しました")


def logs(name: str = "server", tail: int = 40) -> None:
    f = LOG_DIR / f"{name}.log"
    print("\n".join(f.read_text(encoding="utf-8", errors="replace").splitlines()[-tail:]) if f.exists() else "(ログはありません)")
