# インボイス確認ツール(Colab 版)

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/MasakiNiwa/Invoice/blob/main/colab/Invoice_Colab.ipynb)

GitHub Pages 版と**同じ画面(UI)**を、Google Colab の計算資源で動かす版です。

| | GitHub Pages 版 | Colab 版 |
| --- | --- | --- |
| 文字認識 | ブラウザ内(WebGPU / WebAssembly) | Colab のサーバー(GPU / CPU) |
| モデルのダウンロード | 利用者のブラウザに約 21MB | 不要(Colab 側にある) |
| 並列処理 | 端末の性能次第 | サーバーが同時に複数の認識を処理 |
| 利用方法 | URL を開くだけ | ノートブックを実行 → 表示されたリンクからログイン |

## 使い方

1. 上の「Open in Colab」からノートブックを開く
2. 「ランタイム」→「ランタイムのタイプを変更」で **T4 GPU** を選ぶ(CPU でも動きます)
3. セルを上から順に実行し、表示された「アプリを開く」とパスワードでログイン

## しくみ

```
利用者のブラウザ ──https──▶ Cloudflare(クイックトンネル)──▶ Colab
   同じ UI(React)                                         ├ invoice_server(FastAPI)
   ・画像だけを送る                                         │   ├ /login, /api/login  … 起動ごとのパスワードでログイン
   ・判定ロジックはブラウザ                                  │   ├ /api/ocr           … PaddleOCR(ONNX Runtime CUDA/CPU)
                                                           │   └ /*                 … ビルド済みの UI を配信
                                                           └ cloudflared
```

- UI は GitHub Pages 版と同じビルドです。`./api/status` が応答すると「Colab サーバー」と判断し、文字認識をサーバーに任せます(設定で切り替え可)。
- サーバーの文字認識(`server/invoice_server/ocr.py`)は、ブラウザ版(`src/lib/ocr/paddle-core.ts`)と同じ前処理・後処理で同じ形の結果を返します。読み取り・判定の流れ(多段 OCR、記載事項チェック、金額の集計など)は共通のまま使えます。
- UI の取得は 2 通り: `pages`(公開中のビルド `https://masakiniwa.github.io/Invoice/colab/app.zip`)と `build`(指定したブランチのソースからビルド。開発中の版の確認)。
- 起動時は、リンクが実際につながることを確かめてから表示します(Cloudflare は発行直後しばらく Error 1033 になるため。つながらなければ通信方式を変えて作り直します)。起動後も裏で見張り、サーバーやトンネルが止まったら自動で起動し直します。

## リンクは 2 種類

| | ノートブックの中に表示(既定) | 公開リンク(Cloudflare クイックトンネル) |
| --- | --- | --- |
| 開ける人 | このノートブックを開いている人だけ(Colab 公式の埋め込み。Google のログインで守られる) | リンクとパスワードを知っている人(パスワードのみ) |
| 経路 | Google のプロキシ | Cloudflare(通信は https。Cloudflare 側で中継される) |
| 向いている使い方 | 自分で使う・開発中の版の確認 | 全画面で使う・別のアカウントや端末から使う |

自分だけで使うなら、公開リンクを作らない方が攻撃される入り口が少なく安全です。
(Colab のプロキシのリンクを新しいタブで開く方式は、ブラウザのセキュリティ強化で動かなくなっているため使いません)

## セキュリティ

- パスワードは起動のたびに自動生成(12 文字)。同じ IP からの失敗は 10 分に 10 回まで
- ログインは HttpOnly の Cookie(12 時間)。ノートブックの中での表示用に `SameSite=None; Secure; Partitioned`(その埋め込み先でだけ有効)。ログイン前は UI も API も使えません
- 埋め込みは Colab のドメインからだけ許可(`frame-ancestors`)。別のサイトからの POST は拒否
- 画像はメモリ上で処理し、保存しません(開発用の `--debug-dir` を指定したときだけ保存)
- 公開リンクはノートブックを止めると無効になります。パスワード入りのリンク(`/login#pw=…`)は人に送らないでください

## 開発

```bash
npm ci && npm run build                     # UI(dist)とモデル(dist/paddle)を用意
pip install -r colab/server/requirements.txt
cd colab/server
python -m invoice_server --dist ../../dist --password dev   # http://127.0.0.1:8765/
python -m pytest -q                                          # サーバーのテスト(pytest, httpx が必要)
```

`--debug-dir DIR` を付けると、受け取った画像と認識結果を保存します(読み取りの調査用)。

## これから(Colab ならではの機能の候補)

- 高精度モデル(PP-OCRv5 server 版など、ブラウザでは重すぎるモデル)への切り替え
- 画像を 1 回だけ送り、切り出し・前処理・多段読み取りをサーバー側でまとめて実行(通信量と待ち時間を削減)
- 複数の画像・PDF をまとめてアップロードして並列処理
- AI(大規模言語モデル)による項目の読み取り・確認の補助
