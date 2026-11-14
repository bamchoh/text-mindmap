'use strict';

/**
 * テキストをマインドマップの木構造に変換する。
 *
 * 記法:
 *   - インデント（スペース / タブ）の深さで親子関係を表す
 *   - 行頭の "- " "* " "+ " "1. " などの箇条書き記号は省略可能（あれば除去）
 *   - "# 見出し" 形式も使える。見出しレベルが親子関係になり、
 *     見出しの下の箇条書きはその見出しの子になる
 *   - "//" で始まる行はコメント、空行は無視
 *   - ">" で始まる行は直前のノードのメモ（複数行可）
 *   - "// layout: down" のようなコメントでファイルごとのレイアウトを指定
 *
 * トップレベルの項目が 1 つならそれがルート、複数ならファイル名をルートにする。
 *
 * @param {string} text
 * @param {string} fallbackTitle
 * @returns {{text: string, line: number, children: any[]} | null}
 */
function parse(text, fallbackTitle = 'Mindmap') {
  const lines = text.split(/\r?\n/);
  const roots = [];
  const stack = []; // { indent, node }
  let inFence = false;
  let lastNode = null;
  let layout = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const content = raw.trim();
    if (!content) continue;

    // Markdown のコードフェンス内は読み飛ばす
    if (/^(```|~~~)/.test(content)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (content.startsWith('//')) {
      const directive = /^\/\/\s*layout\s*:\s*([a-z]+)\s*$/i.exec(content);
      if (directive) layout = directive[1].toLowerCase();
      continue;
    }
    if (content.startsWith('>')) {
      if (lastNode) {
        const note = content.replace(/^>\s?/, '');
        lastNode.note = lastNode.note === undefined ? note : `${lastNode.note}\n${note}`;
      }
      continue;
    }

    let indent;
    let label;
    const heading = /^(#{1,6})\s+(.*)$/.exec(content);
    if (heading && indentWidth(raw) === 0) {
      // 見出しは常に箇条書きより浅い階層として扱う
      indent = -1000 + heading[1].length;
      label = heading[2];
    } else {
      indent = indentWidth(raw);
      label = content.replace(/^([-*+]|\d+[.)])\s+/, '');
    }
    label = label.trim();

    const node = { line: i, children: [], ...parseInline(label) };
    if (!node.text) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    if (stack.length) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ indent, node });
    lastNode = node;
  }

  if (roots.length === 0) return null;
  const root = roots.length === 1 ? roots[0] : { line: -1, children: roots, ...parseInline(fallbackTitle) };
  if (layout) root.layout = layout;
  return root;
}

// インライン記法: **太字** *斜体* ~~取り消し線~~ `コード` [テキスト](URL) と生の URL
const INLINE_RE =
  /\*\*(.+?)\*\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*(?!\s)(.+?)(?<!\s)\*/g;

/**
 * ノードのラベルを解析する。
 *   行頭の "[ ]" / "[x]"  → チェックボックス
 *   行末の "{red}" / "{#e03131}" → 枝の色
 * @returns {{text: string, spans: object[], checked: boolean | null, color: string | null}}
 */
function parseInline(label) {
  let checked = null;
  let color = null;

  const cb = /^\[([ xX])\]\s*/.exec(label);
  if (cb) {
    checked = cb[1] !== ' ';
    label = label.slice(cb[0].length);
  }
  const col = /\s*\{(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\}\s*$/.exec(label);
  if (col) {
    color = col[1];
    label = label.slice(0, col.index);
  }

  const spans = [];
  const plain = (text) => text && spans.push({ text });
  let last = 0;
  for (const m of label.matchAll(INLINE_RE)) {
    plain(label.slice(last, m.index));
    if (m[1] !== undefined) spans.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) spans.push({ text: m[2], strike: true });
    else if (m[3] !== undefined) spans.push({ text: m[3], code: true });
    else if (m[4] !== undefined) spans.push({ text: m[4], href: m[5] });
    else if (m[6] !== undefined) spans.push({ text: m[6], href: m[6] });
    else if (m[7] !== undefined) spans.push({ text: m[7], italic: true });
    last = m.index + m[0].length;
  }
  plain(label.slice(last));

  return { text: spans.map((s) => s.text).join(''), spans, checked, color };
}

function indentWidth(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else if (ch === '　') col += 2; // 全角スペース
    else break;
  }
  return col;
}

module.exports = { parse, parseInline };
