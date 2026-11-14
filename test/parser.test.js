'use strict';

const assert = require('assert');
const { parse, parseInline } = require('../src/parser');

const simplify = (n) => ({ text: n.text, children: n.children.map(simplify) });
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test('インデントで階層を作る', () => {
  const t = parse('Root\n  A\n    A1\n  B\n');
  assert.deepStrictEqual(simplify(t), {
    text: 'Root',
    children: [{ text: 'A', children: [{ text: 'A1', children: [] }] }, { text: 'B', children: [] }],
  });
});

test('箇条書き記号を除去しタブも扱う', () => {
  const t = parse('Root\n\t- A\n\t\t* A1\n\t+ B\n\t1. C');
  assert.deepStrictEqual(simplify(t).children.map((c) => c.text), ['A', 'B', 'C']);
  assert.strictEqual(t.children[0].children[0].text, 'A1');
});

test('見出しと箇条書きの混在', () => {
  const t = parse('# Root\n## A\n- a1\n  - a2\n## B\n### B1\n- b\n');
  assert.deepStrictEqual(simplify(t), {
    text: 'Root',
    children: [
      { text: 'A', children: [{ text: 'a1', children: [{ text: 'a2', children: [] }] }] },
      { text: 'B', children: [{ text: 'B1', children: [{ text: 'b', children: [] }] }] },
    ],
  });
});

test('トップレベルが複数ならファイル名をルートにする', () => {
  const t = parse('A\nB', 'file');
  assert.strictEqual(t.text, 'file');
  assert.strictEqual(t.line, -1);
  assert.strictEqual(t.children.length, 2);
});

test('コメント・空行・コードフェンスを無視し行番号を保持', () => {
  const t = parse('// c\n\nRoot\n  ```\n  x\n  ```\n  A');
  assert.strictEqual(t.line, 2);
  assert.deepStrictEqual(simplify(t).children, [{ text: 'A', children: [] }]);
  assert.strictEqual(t.children[0].line, 6);
});

test('空の入力は null', () => {
  assert.strictEqual(parse('\n// only comment\n'), null);
});

test('チェックボックスと色指定', () => {
  const t = parse('Root {blue}\n  - [ ] 未完了\n  - [x] 完了 {#e03131}\n  - 色なし {not a color}');
  assert.strictEqual(t.color, 'blue');
  assert.strictEqual(t.text, 'Root');
  assert.deepStrictEqual(t.children.map((c) => [c.text, c.checked, c.color]), [
    ['未完了', false, null],
    ['完了', true, '#e03131'],
    ['色なし {not a color}', null, null],
  ]);
});

test('インライン装飾とリンク', () => {
  const { spans, text } = parseInline('A **太字** *斜体* ~~消~~ `code` [リンク](https://a.jp) と https://b.jp/x.');
  assert.strictEqual(text, 'A 太字 斜体 消 code リンク と https://b.jp/x.');
  assert.deepStrictEqual(spans.filter((s) => Object.keys(s).length > 1), [
    { text: '太字', bold: true },
    { text: '斜体', italic: true },
    { text: '消', strike: true },
    { text: 'code', code: true },
    { text: 'リンク', href: 'https://a.jp' },
    { text: 'https://b.jp/x', href: 'https://b.jp/x' },
  ]);
});

test('snake_case や単独の * は装飾しない', () => {
  const { spans } = parseInline('foo_bar_baz 2 * 3 * 4');
  assert.deepStrictEqual(spans, [{ text: 'foo_bar_baz 2 * 3 * 4' }]);
});

test('メモ行とレイアウト指定', () => {
  const t = parse('// layout: Down\n> 無視されるメモ\nRoot\n  A\n  > 1 行目\n    > 2 行目\n    A1\n  B');
  assert.strictEqual(t.layout, 'down');
  assert.strictEqual(t.note, undefined);
  assert.strictEqual(t.children[0].note, '1 行目\n2 行目');
  assert.strictEqual(t.children[0].children[0].text, 'A1');
  assert.strictEqual(t.children[1].note, undefined);
});

console.log(`\n${passed} tests passed`);
