// @ts-check
// マインドマップの描画ロジック（プレビューと Markdown プレビューで共有）
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e03131', '#5f3dc4'];
  const ROOT_COLOR = '#364fc7';
  const STYLES = [
    { size: 18, weight: '700', padX: 18, padY: 10, radius: 10, stroke: 3.5 },
    { size: 15, weight: '600', padX: 14, padY: 7, radius: 8, stroke: 2.5 },
    { size: 13, weight: '400', padX: 10, padY: 5, radius: 6, stroke: 1.6 },
  ];
  const LAYOUTS = ['both', 'right', 'down', 'tree'];

  // 左右展開
  const H_GAP = 56;
  const V_GAP = 10;
  // 組織図（上→下）
  const DOWN_H_GAP = 16;
  const DOWN_V_GAP = 44;
  const STACK_INDENT = 24;
  const STACK_LINE_X = 10;
  const STACK_GAP = 6;
  // ツリー
  const TREE_INDENT = 36;
  const TREE_V_GAP = 8;
  const TREE_LINE_X = 14;

  const TOGGLE_R = 7;
  const CB_GAP = 6;

  const measureCtx = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'));
  const width = (s) => measureCtx.measureText(s).width;

  // ---------- theme ----------
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function theme() {
    return {
      fg: cssVar('--vscode-editor-foreground', '#333'),
      bg: cssVar('--vscode-editor-background', '#fff'),
      font: cssVar('--vscode-font-family', 'sans-serif'),
      mono: cssVar('--vscode-editor-font-family', 'monospace'),
      link: cssVar('--vscode-textLink-foreground', '#3794ff'),
      code: cssVar('--vscode-textPreformat-foreground', '#d7ba7d'),
    };
  }

  function validColor(c) {
    return c && CSS.supports('color', c) ? c : null;
  }

  /** 背景色に対して読みやすい文字色（白 or 黒）を返す */
  function contrastText(color) {
    measureCtx.fillStyle = '#000';
    measureCtx.fillStyle = color;
    const hex = measureCtx.fillStyle;
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1e1e1e' : '#ffffff';
  }

  // ---------- text ----------
  // 行頭に来てはいけない文字（禁則処理）
  const NO_LINE_START = /^[、。，．,.)\]}）〕］｝〉》」』】・：；:;？！?!ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ～]$/u;
  const isSpace = (s) => /^\s+$/.test(s);

  /** 1 語が最大幅を超える場合（URL など）は区切り文字の後ろ、それでも長ければ 1 文字ずつに分割 */
  function splitLongToken(tok, maxWidth) {
    const pieces = tok.match(/[^/.?&=#_\-]*[/.?&=#_\-]*/g).filter(Boolean);
    return pieces.flatMap((p) => (width(p) > maxWidth ? Array.from(p) : [p]));
  }

  function fontFor(st, span, th) {
    const style = span.italic ? 'italic ' : '';
    const weight = span.bold ? '700' : st.weight;
    return span.code
      ? `${style}${weight} ${Math.round(st.size * 0.92)}px ${th.mono}`
      : `${style}${weight} ${st.size}px ${th.font}`;
  }

  /**
   * 装飾付きテキスト（spans）を最大幅で折り返す。
   * @returns {{w: number, segs: {text: string, span: any}[]}[]}
   */
  function layoutText(spans, st, th, maxWidth) {
    const tokens = [];
    for (const span of spans) {
      measureCtx.font = fontFor(st, span, th);
      for (const raw of span.text.match(/[\x21-\x7e]+|\s+|./gu) || []) {
        const parts = raw.length > 1 && width(raw) > maxWidth ? splitLongToken(raw, maxWidth) : [raw];
        for (const p of parts) tokens.push({ text: p, span, w: width(p) });
      }
    }

    const lines = [];
    let cur = [];
    let curW = 0;
    const flush = () => {
      while (cur.length && isSpace(cur[cur.length - 1].text)) curW -= cur.pop().w;
      lines.push(cur);
      cur = [];
      curW = 0;
    };
    for (const tok of tokens) {
      const space = isSpace(tok.text);
      if (cur.length && !space && curW + tok.w > maxWidth && !NO_LINE_START.test(tok.text)) flush();
      if (space && !cur.length) continue;
      cur.push(tok);
      curW += tok.w;
    }
    if (cur.length || lines.length === 0) flush();

    // 同じ装飾の連続するトークンをまとめる
    return lines.map((toks) => {
      const segs = [];
      for (const t of toks) {
        const prev = segs[segs.length - 1];
        if (prev && prev.span === t.span) prev.text += t.text;
        else segs.push({ text: t.text, span: t.span });
      }
      return { w: toks.reduce((a, t) => a + t.w, 0), segs };
    });
  }

  // ---------- tree annotation ----------
  /**
   * ツリー全体にキー・親・色を付与し、キー → ノードの Map を返す。
   * 描画対象（フォーカス時は部分木）に関係なく、全体の構造で一度だけ計算する。
   */
  function annotate(tree) {
    const byKey = new Map();
    (function walk(node, parent, key, inherited, depth) {
      if (!('ownColor' in node)) node.ownColor = node.color;
      node.key = key;
      node.parent = parent;
      node.absDepth = depth;
      node.color = validColor(node.ownColor) || inherited;
      byKey.set(key, node);
      const seen = {};
      node.children.forEach((child, i) => {
        const base = `${key}/${child.text}`;
        seen[base] = (seen[base] || 0) + 1;
        const childKey = seen[base] > 1 ? `${base}#${seen[base]}` : base;
        walk(child, node, childKey, depth === 0 ? PALETTE[i % PALETTE.length] : node.color, depth + 1);
      });
    })(tree, null, '', ROOT_COLOR, 0);
    return byKey;
  }

  // ---------- layout ----------
  function prepare(node, depth, o, out) {
    const st = STYLES[Math.min(depth, STYLES.length - 1)];
    node.depth = depth;
    node.style = st;
    node.cb = node.checked === null || node.checked === undefined ? 0 : Math.round(st.size * 0.95);
    const cbSpace = node.cb ? node.cb + CB_GAP : 0;
    node.lines = layoutText(node.spans, st, o.th, o.maxNodeWidth - cbSpace);
    node.lineHeight = Math.round(st.size * 1.4);
    const textW = Math.max(...node.lines.map((l) => l.w));
    node.w = Math.ceil(textW) + st.padX * 2 + cbSpace;
    node.h = Math.max(node.lines.length * node.lineHeight, node.cb) + st.padY * 2;
    node.collapsed =
      depth > 0 && node.children.length > 0 && !!o.collapsed[node.key] && !o.forceOpen.has(node.key);
    node.dir = 1;
    node.stacked = false;
    out.push(node);
    for (const child of node.children) prepare(child, depth + 1, o, out);
  }

  const visibleChildren = (n) => (n.collapsed ? [] : n.children);

  // 左右展開 / 右のみ
  function layoutHorizontal(root, o) {
    const measure = (n) => {
      const kids = visibleChildren(n);
      if (!kids.length) return (n.sh = n.h);
      let sum = V_GAP * (kids.length - 1);
      for (const k of kids) sum += measure(k);
      return (n.sh = Math.max(n.h, sum));
    };
    const place = (parent, kids, dir) => {
      const total = kids.reduce((a, k) => a + k.sh, 0) + V_GAP * (kids.length - 1);
      let y = parent.y - total / 2;
      for (const k of kids) {
        k.dir = dir;
        k.y = y + k.sh / 2;
        k.x = parent.x + dir * (parent.w / 2 + H_GAP + k.w / 2);
        place(k, visibleChildren(k), dir);
        y += k.sh + V_GAP;
      }
    };

    root.x = 0;
    root.y = 0;
    const kids = visibleChildren(root);
    for (const k of kids) measure(k);
    let right = kids;
    let left = [];
    if (o.layout === 'both' && kids.length > 1) {
      const total = kids.reduce((a, k) => a + k.sh, 0);
      right = [];
      let acc = 0;
      for (const k of kids) {
        if (left.length === 0 && acc + k.sh / 2 <= total / 2) {
          right.push(k);
          acc += k.sh;
        } else {
          left.push(k);
        }
      }
      left.reverse(); // 時計回りに読めるよう左側は下から上へ
    }
    place(root, right, 1);
    place(root, left, -1);
  }

  // 組織図（上から下へ）
  // 子がすべて葉のノードは、横に並べると極端に横長になるため縦に積む
  function layoutDown(root) {
    const isStack = (n) => {
      const kids = visibleChildren(n);
      return n.depth >= 1 && kids.length > 0 && kids.every((k) => visibleChildren(k).length === 0);
    };
    const measure = (n) => {
      const kids = visibleChildren(n);
      if (!kids.length) return (n.sw = n.w);
      if (isStack(n)) {
        const maxW = Math.max(...kids.map((k) => k.w));
        return (n.sw = Math.max(n.w, 2 * (STACK_INDENT + maxW - n.w / 2)));
      }
      let sum = DOWN_H_GAP * (kids.length - 1);
      for (const k of kids) sum += measure(k);
      return (n.sw = Math.max(n.w, sum));
    };
    const place = (parent) => {
      const kids = visibleChildren(parent);
      if (!kids.length) return;
      if (isStack(parent)) {
        let y = parent.y + parent.h / 2 + TOGGLE_R * 2 + 10;
        for (const k of kids) {
          k.stacked = true;
          k.x = parent.x - parent.w / 2 + STACK_INDENT + k.w / 2;
          k.y = y + k.h / 2;
          y += k.h + STACK_GAP;
        }
        return;
      }
      const total = kids.reduce((a, k) => a + k.sw, 0) + DOWN_H_GAP * (kids.length - 1);
      let x = parent.x - total / 2;
      const top = parent.y + parent.h / 2 + DOWN_V_GAP;
      for (const k of kids) {
        k.x = x + k.sw / 2;
        k.y = top + k.h / 2;
        place(k);
        x += k.sw + DOWN_H_GAP;
      }
    };
    measure(root);
    root.x = 0;
    root.y = 0;
    place(root);
  }

  // ツリー（エクスプローラー風）
  function layoutTree(root) {
    let y = 0;
    (function place(n, left) {
      n.x = left + n.w / 2;
      n.y = y + n.h / 2;
      y += n.h + TREE_V_GAP;
      for (const k of visibleChildren(n)) place(k, left + TREE_INDENT);
    })(root, 0);
  }

  const LAYOUT_FNS = { both: layoutHorizontal, right: layoutHorizontal, down: layoutDown, tree: layoutTree };

  // ---------- rendering ----------
  function el(name, attrs, parent) {
    const e = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.appendChild(e);
    return e;
  }

  function elbow(sx, sy, ex, ey) {
    const r = Math.min(6, Math.abs(ey - sy));
    return `M${sx},${sy} V${ey - r} Q${sx},${ey} ${sx + r},${ey} H${ex}`;
  }

  function edgePath(p, c, layout) {
    if (c.stacked) {
      return elbow(p.x - p.w / 2 + STACK_LINE_X, p.y + p.h / 2, c.x - c.w / 2, c.y);
    }
    if (layout === 'down') {
      const sx = p.x;
      const sy = p.y + p.h / 2;
      const ex = c.x;
      const ey = c.y - c.h / 2;
      const k = DOWN_V_GAP * 0.6;
      return `M${sx},${sy} C${sx},${sy + k} ${ex},${ey - k} ${ex},${ey}`;
    }
    if (layout === 'tree') {
      return elbow(p.x - p.w / 2 + TREE_LINE_X, p.y + p.h / 2, c.x - c.w / 2, c.y);
    }
    const dir = c.dir;
    const sx = p.depth === 0 ? p.x + dir * (p.w / 2 - 4) : p.x + dir * p.w / 2;
    const sy = p.y;
    const ex = c.x - dir * c.w / 2;
    const ey = c.y;
    const k = H_GAP * 0.6;
    return `M${sx},${sy} C${sx + dir * k},${sy} ${ex - dir * k},${ey} ${ex},${ey}`;
  }

  function togglePos(n, layout) {
    if (layout === 'down') return [n.x, n.y + n.h / 2 + TOGGLE_R + 2];
    return [n.x + n.dir * (n.w / 2 + TOGGLE_R + 2), n.y];
  }

  function countDescendants(n) {
    return n.children.reduce((a, c) => a + 1 + countDescendants(c), 0);
  }

  function drawNode(n, layer, o, bounds) {
    const th = o.th;
    const st = n.style;
    const left = n.x - n.w / 2;
    const top = n.y - n.h / 2;
    const g = el('g', { class: 'node', 'data-key': n.key, 'data-line': n.line }, layer);
    n.el = g;

    let fill, stroke, textColor, fillOpacity = 1;
    if (n.depth === 0) {
      fill = n.color; stroke = n.color; textColor = contrastText(n.color);
    } else if (n.depth === 1) {
      fill = n.color; stroke = n.color; textColor = th.fg; fillOpacity = 0.16;
    } else {
      fill = th.bg; stroke = n.color; textColor = th.fg;
    }
    if (n.depth === 1) {
      // 半透明の塗りの下に背景色を敷いて、エッジが透けないようにする
      el('rect', { x: left, y: top, width: n.w, height: n.h, rx: st.radius, fill: th.bg }, g);
    }
    el('rect', {
      class: 'box', x: left, y: top, width: n.w, height: n.h, rx: st.radius,
      fill, 'fill-opacity': fillOpacity, stroke, 'stroke-width': n.depth >= 2 ? 1.2 : 2,
    }, g);

    let textX = left + st.padX;
    if (n.cb) {
      const cx = textX;
      const cy = n.y - n.cb / 2;
      const cg = el('g', { class: 'checkbox', 'data-check': n.line }, g);
      el('rect', {
        x: cx, y: cy, width: n.cb, height: n.cb, rx: 3,
        fill: n.checked ? n.color : th.bg, stroke: n.color, 'stroke-width': 1.5,
      }, cg);
      if (n.checked) {
        const s = n.cb;
        el('path', {
          d: `M${cx + s * 0.22},${cy + s * 0.52} L${cx + s * 0.42},${cy + s * 0.72} L${cx + s * 0.78},${cy + s * 0.3}`,
          fill: 'none', stroke: contrastText(n.color), 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, cg);
      }
      textX += n.cb + CB_GAP;
    }

    // 下線・取り消し線を正しい位置に出すため、通常のベースラインで描画し位置で中央揃えする
    const text = el('text', {
      fill: textColor, 'font-family': th.font, 'font-size': st.size, 'font-weight': st.weight,
    }, g);
    if (n.checked) text.setAttribute('opacity', '0.6');
    const textTop = n.y - (n.lines.length * n.lineHeight) / 2;
    const baselineOffset = st.size * 0.36;
    n.lines.forEach((line, i) => {
      const lt = el('tspan', { x: textX, y: textTop + n.lineHeight * (i + 0.5) + baselineOffset }, text);
      for (const seg of line.segs) {
        const sp = seg.span;
        const a = {};
        const deco = [];
        if (sp.bold) a['font-weight'] = '700';
        if (sp.italic) a['font-style'] = 'italic';
        if (sp.code) {
          a['font-family'] = th.mono;
          a['font-size'] = Math.round(st.size * 0.92);
          a.fill = n.depth === 0 ? textColor : th.code;
        }
        if (sp.strike) deco.push('line-through');
        if (sp.href) {
          a.class = 'link';
          a['data-href'] = sp.href;
          if (n.depth !== 0) a.fill = th.link;
          deco.push('underline');
        }
        if (deco.length) a['text-decoration'] = deco.join(' ');
        const t = el('tspan', a, lt);
        t.textContent = seg.text;
      }
    });

    // 独自ツールチップがない環境（Markdown プレビュー）向けに、ブラウザ標準のツールチップを付ける
    if (o.nativeTitle) {
      const title = el('title', {}, g);
      title.textContent = n.note ? `${n.text}\n\n${n.note}` : n.text;
    }

    // メモがあるノードは右上にバッジを表示
    if (n.note) {
      el('circle', {
        class: 'note-badge', cx: left + n.w - 3, cy: top + 3, r: 4.5,
        fill: n.depth === 0 ? contrastText(n.color) : n.color, stroke: th.bg, 'stroke-width': 1.5,
      }, g);
    }

    extend(bounds, left, top, left + n.w, top + n.h);

    if (n.depth > 0 && n.children.length > 0) {
      const [tx, ty] = togglePos(n, o.layout);
      const tg = el('g', { class: 'toggle', 'data-toggle': n.key }, g);
      el('circle', { cx: tx, cy: ty, r: TOGGLE_R, fill: th.bg, stroke: n.color, 'stroke-width': 1.5 }, tg);
      if (n.collapsed) {
        const label = el('text', {
          x: tx, y: ty, 'text-anchor': 'middle', 'dominant-baseline': 'central',
          fill: n.color, 'font-family': th.font, 'font-size': 9, 'font-weight': '700',
        }, tg);
        label.textContent = String(countDescendants(n));
      } else {
        el('line', { x1: tx - 3.5, y1: ty, x2: tx + 3.5, y2: ty, stroke: n.color, 'stroke-width': 1.5 }, tg);
      }
      extend(bounds, tx - TOGGLE_R, ty - TOGGLE_R, tx + TOGGLE_R, ty + TOGGLE_R);
    }
  }

  function extend(b, x1, y1, x2, y2) {
    b.minX = Math.min(b.minX, x1);
    b.minY = Math.min(b.minY, y1);
    b.maxX = Math.max(b.maxX, x2);
    b.maxY = Math.max(b.maxY, y2);
  }

  /**
   * root 以下を container（SVG の g 要素）に描画する。
   * 事前に annotate() でツリー全体にキーと色を付けておくこと。
   * @returns {{nodes: any[], bounds: {minX: number, minY: number, maxX: number, maxY: number}}}
   */
  function render(container, root, opts = {}) {
    const o = {
      layout: LAYOUTS.includes(opts.layout) ? opts.layout : 'both',
      maxNodeWidth: opts.maxNodeWidth || 240,
      collapsed: opts.collapsed || {},
      forceOpen: opts.forceOpen || new Set(),
      nativeTitle: opts.nativeTitle !== false,
      th: opts.theme || theme(),
    };
    container.textContent = '';
    const nodes = [];
    prepare(root, 0, o, nodes);
    LAYOUT_FNS[o.layout](root, o);

    const edgeLayer = el('g', { class: 'edges', fill: 'none' }, container);
    const nodeLayer = el('g', { class: 'nodes' }, container);
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    (function walk(n) {
      drawNode(n, nodeLayer, o, bounds);
      for (const k of visibleChildren(n)) {
        el('path', {
          d: edgePath(n, k, o.layout),
          stroke: k.color,
          'stroke-width': o.layout === 'tree' ? Math.min(k.style.stroke, 2) : k.style.stroke,
          'stroke-linecap': 'round',
        }, edgeLayer);
        walk(k);
      }
    })(root);
    return { nodes, bounds };
  }

  global.MindmapRenderer = { render, annotate, theme, LAYOUTS, SVG_NS };
})(window);
