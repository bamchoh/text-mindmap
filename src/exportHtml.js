'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * Markdown を、マインドマップ描画スクリプトを埋め込んだ単体の HTML ファイルとして書き出す。
 * 変換には VS Code 標準の Markdown エンジン（markdown.api.render）を使うので、
 * プレビューと同じプラグイン（この拡張の ```mindmap を含む）が適用される。
 */
async function exportMarkdownHtml(context, uri) {
  const document = await resolveMarkdownDocument(uri);
  if (!document) {
    vscode.window.showWarningMessage('書き出す Markdown ファイルを開いてから実行してください。');
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: document.uri.with({ path: document.uri.path.replace(/\.[^/.]+$/, '') + '.html' }),
    filters: { HTML: ['html'] },
  });
  if (!target) return;

  let body = await vscode.commands.executeCommand('markdown.api.render', document);
  if (typeof body !== 'string') {
    vscode.window.showErrorMessage('Markdown の変換に失敗しました。');
    return;
  }
  body = restoreImageSources(body);

  let missing = [];
  if (vscode.workspace.getConfiguration('mindmap', document.uri).get('export.embedImages', true)) {
    ({ html: body, missing } = await embedImages(body, document.uri));
  }

  const media = (file) => fs.readFileSync(path.join(context.extensionUri.fsPath, 'media', file), 'utf8');
  const title = firstHeading(document.getText()) || path.basename(document.fileName, path.extname(document.fileName));
  const html = buildHtml({
    title,
    body,
    css: media('export.css') + '\n' + media('markdown-preview.css'),
    scripts: [media('renderer.js'), media('markdown-preview.js')],
  });

  await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
  if (missing.length) {
    vscode.window.showWarningMessage(
      `見つからない画像があったため、埋め込まずにパスのまま出力しました: ${missing.join(', ')}`
    );
  }
  const open = 'ブラウザで開く';
  const choice = await vscode.window.showInformationMessage(
    `HTML を書き出しました: ${path.basename(target.fsPath)}`,
    open
  );
  if (choice === open) await vscode.env.openExternal(target);
}

/** 引数・アクティブなエディタ・Markdown プレビューのタブから、対象の Markdown ドキュメントを探す */
async function resolveMarkdownDocument(uri) {
  // Markdown プレビュー（Webview）のタイトルバーから実行すると、ファイルではなく
  // "webview-panel:..." という内部 URI が渡されるので、その場合は無視して他の方法で探す
  if (uri instanceof vscode.Uri && uri.scheme !== 'webview-panel') {
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      // 開けない URI なら下の方法で探す
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'markdown') return editor.document;

  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    return vscode.workspace.openTextDocument(input.uri);
  }
  if (input instanceof vscode.TabInputWebview && tab) {
    // Markdown プレビュー（「プレビュー xxx.md」のようなタブ名）から元ファイルを推測する
    const docs = vscode.workspace.textDocuments.filter(
      (d) => d.languageId === 'markdown' && tab.label.includes(path.basename(d.fileName))
    );
    if (docs.length === 1) return docs[0];
    // ドキュメントが開かれていなければ、タブ名のファイル名でワークスペースを検索する
    const name = /([^\s/\\]+\.(?:md|markdown))\b/i.exec(tab.label);
    if (name) {
      const found = await vscode.workspace.findFiles(`**/${name[1]}`, '**/node_modules/**', 2);
      if (found.length === 1) return vscode.workspace.openTextDocument(found[0]);
    }
  }

  const visible = vscode.window.visibleTextEditors.filter((e) => e.document.languageId === 'markdown');
  if (visible.length === 1) return visible[0].document;
  return undefined;
}

/** プレビュー用に書き換えられた画像パスを、元の（相対）パスに戻す */
function restoreImageSources(html) {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const original = /\bdata-src="([^"]*)"/.exec(tag);
    return original ? tag.replace(/\bsrc="[^"]*"/, `src="${original[1]}"`) : tag;
  });
}

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/**
 * ローカルの画像を data URI として HTML に埋め込む。
 * http(s) や data: の画像はそのまま。見つからない画像はパスのまま残し、一覧を返す。
 */
async function embedImages(html, documentUri) {
  const baseDir = vscode.Uri.joinPath(documentUri, '..');
  const tags = [...new Set(html.match(/<img\b[^>]*>/g) || [])];
  const missing = [];
  const replacements = new Map();

  for (const tag of tags) {
    const m = /\bsrc="([^"]*)"/.exec(tag);
    if (!m) continue;
    const src = decodeHtml(m[1]);
    const fileUri = resolveLocalImage(src, baseDir);
    if (!fileUri) continue;
    const type = IMAGE_TYPES[path.extname(fileUri.path).toLowerCase()];
    if (!type) continue;
    try {
      const data = await vscode.workspace.fs.readFile(fileUri);
      const dataUri = `data:${type};base64,${Buffer.from(data).toString('base64')}`;
      replacements.set(tag, tag.replace(m[0], `src="${dataUri}"`).replace(/\s*\bdata-src="[^"]*"/, ''));
    } catch {
      missing.push(src);
    }
  }

  const out = html.replace(/<img\b[^>]*>/g, (tag) => replacements.get(tag) || tag);
  return { html: out, missing };
}

/** 画像の src をローカルファイルの URI に変換する。ローカルでなければ undefined */
function resolveLocalImage(src, baseDir) {
  if (!src || /^(https?:|data:|blob:|\/\/)/i.test(src)) return undefined;
  if (/^file:/i.test(src)) return vscode.Uri.parse(src);
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return undefined; // その他のスキーム
  const clean = safeDecode(src.replace(/[?#].*$/, ''));
  if (/^[a-z]:[\\/]/i.test(clean)) return vscode.Uri.file(clean);
  if (clean.startsWith('/')) {
    // プレビューと同様、"/" 始まりはワークスペースのルートからのパスとして扱う
    const folder = vscode.workspace.getWorkspaceFolder(baseDir);
    return folder ? vscode.Uri.joinPath(folder.uri, ...clean.split('/').filter(Boolean)) : vscode.Uri.file(clean);
  }
  return vscode.Uri.joinPath(baseDir, ...clean.split(/[\\/]/));
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function firstHeading(text) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : '';
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// </script> がスクリプト本文に含まれていても HTML が壊れないようにする
const escapeScript = (s) => s.replace(/<\/script/gi, '<\\/script');

function buildHtml({ title, body, css, scripts }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main class="markdown-body">
${body}
</main>
${scripts.map((s) => `<script>\n${escapeScript(s)}\n</script>`).join('\n')}
</body>
</html>
`;
}

module.exports = { exportMarkdownHtml };
