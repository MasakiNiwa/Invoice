"""サーバーのテスト(ビルド済みの dist と PaddleOCR のモデルが必要: npm run build のあとに実行)

    cd colab/server && python -m pytest -q
"""
import os
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from invoice_server.app import create_app

ROOT = Path(__file__).resolve().parents[3]
DIST = Path(os.environ.get("INVOICE_DIST", ROOT / "dist"))

pytestmark = pytest.mark.skipif(not (DIST / "index.html").exists() or not (DIST / "paddle" / "rec.onnx").exists(), reason="dist がありません(npm run build)")


@pytest.fixture(scope="module")
def client():
    app = create_app(DIST, password="test-pass", device="cpu", version="test")
    return TestClient(app)


def sample_png(text_lines=("INVOICE T7810648631842", "TOTAL 1,100")) -> bytes:
    img = np.full((240, 900, 3), 255, np.uint8)
    for i, t in enumerate(text_lines):
        cv2.putText(img, t, (30, 80 + i * 90), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3, cv2.LINE_AA)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


def test_requires_login(client):
    assert client.get("/", follow_redirects=False).status_code == 303
    r = client.get("/api/status")
    assert r.status_code == 401 and r.json()["app"] == "invoice-colab"
    assert client.post("/api/ocr", content=sample_png()).status_code == 401
    assert client.get("/login").status_code == 200


def test_wrong_password_and_rate_limit():
    app = create_app(DIST, password="right", device="cpu")
    c = TestClient(app)
    for _ in range(10):
        assert c.post("/api/login", json={"password": "wrong"}).status_code == 401
    assert c.post("/api/login", json={"password": "right"}).status_code == 429


def test_login_status_ocr_and_static(client):
    assert client.post("/api/login", json={"password": "test-pass"}).status_code == 200
    st = client.get("/api/status").json()
    assert st["app"] == "invoice-colab" and st["provider"] in ("cpu", "cuda")
    r = client.post("/api/ocr?psm=3", content=sample_png(), headers={"content-type": "image/png"})
    assert r.status_code == 200
    text = r.json()["text"].replace(" ", "")
    assert "7810648631842" in text
    d = client.post("/api/ocr?psm=3&detectOnly=1", content=sample_png()).json()
    assert len(d["lines"]) >= 2 and all("angle" in l for l in d["lines"])
    img = np.full((70, 560, 3), 255, np.uint8)
    cv2.putText(img, "T7810648631842", (10, 52), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3, cv2.LINE_AA)
    line = client.post("/api/ocr?psm=7", content=cv2.imencode(".png", img)[1].tobytes()).json()
    assert "7810648631842" in line["text"]
    assert "<html" in client.get("/").text.lower()
    assert client.get("/no/such/route").status_code == 200  # SPA のフォールバック
    assert client.get("/../../etc/passwd").status_code in (200, 404)
    assert "root:" not in client.get("/../../etc/passwd").text
    assert client.post("/api/ocr", content=b"not an image").status_code == 400
