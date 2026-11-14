'use strict';

const vscode = require('vscode');
const path = require('path');
const { parse } = require('./src/parser');
const { exportMarkdownHtml } = require('./src/exportHtml');

/** @type {Map<string, MindmapPreview>} document URI -> preview */
const previews = new Map();

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mindmap.showPreview', (uri) =>
      openPreview(context, uri, vscode.ViewColumn.Active)
    ),
    vscode.commands.registerCommand('mindmap.showPreviewToSide', (uri) =>
      openPreview(context, uri, vscode.ViewColumn.Beside)
    ),
    vscode.commands.registerCommand('mindmap.exportMarkdownHtml', (uri) => exportMarkdownHtml(context, uri)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const p = previews.get(e.document.uri.toString());
      if (p) p.scheduleUpdate(e.document);
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      const p = previews.get(e.textEditor.document.uri.toString());
      if (p) p.postCursor(e.selections[0].active.line);
    }),
    vscode.languages.registerDocumentSymbolProvider({ language: 'mindmap' }, new OutlineProvider()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('mindmap')) return;
      for (const p of previews.values()) p.refresh();
    })
  );

  return { extendMarkdownIt };
}

/** Markdown プレビューで ```mindmap コードブロックをマインドマップとして描画する */
function extendMarkdownIt(md) {
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.info.trim().split(/\s+/)[0].toLowerCase() !== 'mindmap') {
      return defaultFence(tokens, idx, options, env, self);
    }
    const config = vscode.workspace.getConfiguration('mindmap');
    const data = {
      tree: parse(token.content, 'Mindmap'),
      layout: config.get('layout', 'both'),
      maxNodeWidth: config.get('maxNodeWidth', 240),
    };
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';
    return `<div class="mindmap-embed code-line"${lineAttr} data-mindmap="${md.utils.escapeHtml(JSON.stringify(data))}"></div>\n`;
  };
  return md;
}

async function openPreview(context, uri, column) {
  let document;
  if (uri instanceof vscode.Uri) {
    document = await vscode.workspace.openTextDocument(uri);
  } else if (vscode.window.activeTextEditor) {
    document = vscode.window.activeTextEditor.document;
  } else {
    vscode.window.showWarningMessage('プレビューするマインドマップファイルを開いてください。');
    return;
  }

  const key = document.uri.toString();
  const existing = previews.get(key);
  if (existing) {
    existing.panel.reveal(column);
    return;
  }
  previews.set(key, new MindmapPreview(context, document, column));
}

class MindmapPreview {
  constructor(context, document, column) {
    this.context = context;
    this.uri = document.uri;
    this.timer = undefined;
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

    this.panel = vscode.window.createWebviewPanel(
      'mindmap.preview',
      `Mindmap: ${path.basename(document.fileName)}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot] }
    );
    this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.panel.webview.html = this.getHtml(mediaRoot);

    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      clearTimeout(this.timer);
      previews.delete(this.uri.toString());
    });
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.refresh();
        break;
      case 'reveal':
        await this.revealLine(msg.line);
        break;
      case 'exportSvg':
        await this.exportSvg(msg.svg);
        break;
      case 'exportPng':
        await this.exportPng(msg.data);
        break;
      case 'openLink':
        await this.openLink(msg.href);
        break;
      case 'toggleCheck':
        await this.toggleCheck(msg.line);
        break;
    }
  }

  async openLink(href) {
    if (typeof href !== 'string' || !href) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // 外部 URL は http(s) と mailto のみ許可
      if (/^(https?|mailto):/i.test(href)) await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    // それ以外はこのファイルからの相対パスとして開く
    const target = vscode.Uri.joinPath(this.uri, '..', decodeURIComponent(href));
    await vscode.commands.executeCommand('vscode.open', target);
  }

  async toggleCheck(line) {
    const doc = await vscode.workspace.openTextDocument(this.uri);
    if (typeof line !== 'number' || line < 0 || line >= doc.lineCount) return;
    const text = doc.lineAt(line).text;
    const m = /^(\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+)?)\[([ xX])\]/.exec(text);
    if (!m) return;
    const col = m[1].length + 1;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(line, col, line, col + 1), m[2] === ' ' ? 'x' : ' ');
    await vscode.workspace.applyEdit(edit);
  }

  async refresh() {
    const doc = await vscode.workspace.openTextDocument(this.uri);
    this.update(doc);
  }

  scheduleUpdate(document) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(document), 150);
  }

  update(document) {
    const config = vscode.workspace.getConfiguration('mindmap', document.uri);
    const title = path.basename(document.fileName, path.extname(document.fileName));
    this.panel.webview.postMessage({
      type: 'update',
      tree: parse(document.getText(), title),
      config: {
        layout: config.get('layout', 'both'),
        maxNodeWidth: config.get('maxNodeWidth', 240),
      },
    });
  }

  postCursor(line) {
    this.panel.webview.postMessage({ type: 'cursor', line });
  }

  async revealLine(line) {
    if (typeof line !== 'number' || line < 0) return;
    const uriStr = this.uri.toString();
    const visible = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uriStr
    );
    const editor = await vscode.window.showTextDocument(this.uri, {
      viewColumn: visible ? visible.viewColumn : vscode.ViewColumn.Beside,
    });
    const lineText = editor.document.lineAt(line);
    const pos = new vscode.Position(line, lineText.firstNonWhitespaceCharacterIndex);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async exportSvg(svg) {
    await this.saveFile('svg', 'SVG', Buffer.from(svg, 'utf8'));
  }

  async exportPng(base64) {
    await this.saveFile('png', 'PNG', Buffer.from(base64, 'base64'));
  }

  async saveFile(ext, label, data) {
    const defaultUri = this.uri.with({ path: this.uri.path.replace(/\.[^/.]+$/, '') + '.' + ext });
    const target = await vscode.window.showSaveDialog({ defaultUri, filters: { [label]: [ext] } });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, data);
    vscode.window.showInformationMessage(`${label} を保存しました: ${path.basename(target.fsPath)}`);
  }

  getHtml(mediaRoot) {
    const webview = this.panel.webview;
    const uri = (file) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, file));
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('preview.css')}">
<title>Mindmap</title>
</head>
<body>
<div id="topleft">
  <div id="crumbs" hidden></div>
  <div id="search" hidden>
    <input id="search-input" type="text" placeholder="検索" spellcheck="false">
    <span id="search-count"></span>
    <button id="search-prev" title="前へ (Shift+Enter)">↑</button>
    <button id="search-next" title="次へ (Enter)">↓</button>
    <button id="search-close" title="閉じる (Esc)">×</button>
  </div>
</div>
<div id="toolbar">
  <button data-action="zoomOut" title="縮小 (-)">−</button>
  <button data-action="zoomIn" title="拡大 (+)">＋</button>
  <button data-action="fit" title="全体を表示 (F)">Fit</button>
  <span class="sep"></span>
  <button data-action="expandAll" title="すべて展開">展開</button>
  <button data-action="collapseAll" title="第 1 階層まで折りたたむ">折畳</button>
  <span class="sep"></span>
  <select id="layout" title="レイアウト">
    <option value="both">左右</option>
    <option value="right">右</option>
    <option value="down">組織図</option>
    <option value="tree">ツリー</option>
  </select>
  <button data-action="search" title="検索 (Ctrl+F)">検索</button>
  <span class="sep"></span>
  <button data-action="exportSvg" title="SVG として保存">SVG</button>
  <button data-action="exportPng" title="PNG として保存">PNG</button>
  <button data-action="copyPng" title="画像をクリップボードにコピー">コピー</button>
</div>
<div id="empty" hidden>項目がありません。テキストを入力してください。</div>
<div id="tooltip" hidden></div>
<div id="toast" hidden></div>
<svg id="canvas" xmlns="http://www.w3.org/2000/svg"><g id="viewport"></g></svg>
<script nonce="${nonce}" src="${uri('renderer.js')}"></script>
<script nonce="${nonce}" src="${uri('preview.js')}"></script>
</body>
</html>`;
  }
}

/** アウトラインパネル・パンくずリスト用にノードの階層を返す */
class OutlineProvider {
  provideDocumentSymbols(document) {
    const tree = parse(document.getText(), '');
    if (!tree) return [];

    const lastLine = (n) => n.children.reduce((max, c) => Math.max(max, lastLine(c)), n.line);
    const toSymbol = (n, depth) => {
      const line = document.lineAt(n.line);
      const end = document.lineAt(lastLine(n));
      const symbol = new vscode.DocumentSymbol(
        n.text,
        n.checked === null ? '' : n.checked ? '☑' : '☐',
        depth === 0 ? vscode.SymbolKind.Namespace : n.children.length ? vscode.SymbolKind.Class : vscode.SymbolKind.Field,
        new vscode.Range(line.range.start, end.range.end),
        line.range
      );
      symbol.children = n.children.map((c) => toSymbol(c, depth + 1));
      return symbol;
    };
    // 複数ルート（仮のルート）の場合はトップレベル項目をそのまま並べる
    return tree.line < 0 ? tree.children.map((c) => toSymbol(c, 1)) : [toSymbol(tree, 0)];
  }
}

function deactivate() {}

module.exports = { activate, deactivate, extendMarkdownIt };
