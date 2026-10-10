# インボイス確認ツール

適格請求書(インボイス)の画像・PDFから **登録番号(T番号)** を高精度に読み取り、チェックディジットで検算し、
国税庁「適格請求書発行事業者公表サイト」の該当ページへのリンクを表示するWebアプリです。

**▶ 公開ページ: https://masakiniwa.github.io/Invoice/**

**▶ Colab 版(GPU で高速に動かす): [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/MasakiNiwa/Invoice/blob/main/colab/Invoice_Colab.ipynb)** — 同じ画面を Google Colab の GPU で動かします([説明](colab/README.md))

## 特長

- 📥 **入力**: ドラッグ&ドロップ / ファイル選択(画像・PDF)/ スクショ貼り付け(Ctrl+V)/ スマホのカメラ撮影
- 🚀 **2つのOCRエンジン**: 日本語に強い PaddleOCR(PP-OCRv5、WebGPU で GPU 実行)と Tesseract を切り替え可能
- 🔍 **多段捜査OCR**: 全体を1回OCRするだけでなく、
  「T」や「登録番号」の近くを文字サイズに合わせて拡大して精査、
  「同じ大きさの文字が横に並ぶ領域」を画像処理で検出、
  タイル分割×ズームで全体を走査、と段階的に絞り込みます
- 🧮 **検算**: T番号のチェックディジットで誤読を検出。桁ごとの多数決・取り違えやすい数字の補正候補も提示
- 👀 **可視化**: 捜査中の領域・アンカー・候補を画像上にアニメーション表示、OCR中の部分を「ルーペ」で表示
- 🔗 **公表サイト連携**: 読み取った番号の公表サイトページをワンクリックで開く
- 📚 **PDF一括チェック**: 複数ページの PDF を全ページ読み取り、1ページに複数のインボイスがあっても分けて判定・CSV 出力
- 🧾 **記載事項チェック**: 6項目+税額・合計・日付の検算。記載事項の行は何度も読み直して多数決
- 🧮 **金額の集計・精算チェック**: 明細の合計と記載の合計の照合(ETC 利用明細など)、領収書の束の合計・登録番号なしの検出・精算金額との照合
- 📱 **PWA**: ホーム画面に追加してオフラインでも利用可
- 🔒 **プライバシー**: 画像はブラウザ内で処理され、外部に送信されません(Colab 版では、画像を自分で起動した Colab のサーバーに送って処理します)
- ☁️ **Colab 版**: 同じ UI を Colab の GPU で。ブラウザにモデルを読み込まず、起動ごとのパスワードでログイン
- 📱 スマホ・PC対応、ダークモード対応

## 開発

```bash
npm install
npm run dev        # 開発サーバー
npm test           # ユニットテスト (Vitest)
npm run build      # 本番ビルド (dist/)
```

- 技術: Vite + React + TypeScript + Tailwind CSS / PaddleOCR (PP-OCRv5) + ONNX Runtime Web (WebGPU/WASM) / tesseract.js / pdf.js / zustand
- OCRのモデル・ワーカー(PaddleOCR: `public/paddle/`、Tesseract: `public/ocr/`)は `scripts/copy-ocr-assets.mjs` で npm パッケージからコピーし、自前でホスティングします(CDN非依存)
- 仕様・ロードマップ: [docs/SPEC.md](docs/SPEC.md)

## デプロイ

`main` ブランチへのマージで GitHub Actions が GitHub Pages に自動デプロイします。
初回のみ、リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にしてください。

## ライセンス

[MIT](LICENSE)

本ツールは国税庁とは関係のない非公式ツールです。読み取り結果は必ず公表サイトでご確認ください。
