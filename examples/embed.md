# Markdown への埋め込み例

Markdown プレビュー（`Ctrl+Shift+V`）を開くと、下のコードブロックがマインドマップとして表示されます。

```mindmap
// layout: down
リリース計画
  - 準備
    - [x] 仕様確定
    - [ ] レビュー
  - 実装
    - **パーサー**
    - プレビュー
  - リリース
    - Marketplace 公開
    > README とスクリーンショットを用意する
```

## ツリー型

```mindmap
// layout: tree
プロジェクト構成
  - src
    - parser.js
  - media
    - renderer.js
    - preview.js
  - extension.js
```
