// @ts-check
// プレビュー用 Webview の操作（パン・ズーム、フォーカス、検索、書き出しなど）
(function () {
  'use strict';

  const R = window.MindmapRenderer;
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const svg = $('canvas');
  const viewport = $('viewport');

  const state = Object.assign(
    { collapsed: {}, transform: null, focusKey: null, layoutOverride: null },
    vscode.getState() || {}
  );
  let transform = state.transform || { x: 0, y: 0, k: 1 };
  let needsFit = !state.transform;

  let tree = null;
  /** @type {Map<string, any>} */
  let byKey = new Map();
  let config = { layout: 'both', maxNodeWidth: 240 };
  let cursorLine = -1;
  let nodes = [];
  let bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  const search = { open: false, query: '', matches: [], index: 0 };

  // ---------- messaging ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'update') {
      tree = msg.tree;
      config = msg.config;
      byKey = tree ? R.annotate(tree) : new Map();
      if (state.focusKey !== null && !byKey.has(state.focusKey)) state.focusKey = null;
      render();
    } else if (msg.type === 'cursor') {
      cursorLine = msg.line;
      applyActive();
    }
  });

  function saveState() {
    state.transform = transform;
    vscode.setState(state);
  }

  // ---------- render ----------
  function currentLayout() {
    const l = state.layoutOverride || (tree && tree.layout) || config.layout;
    return R.LAYOUTS.includes(l) ? l : 'both';
  }

  function render() {
    $('empty').hidden = !!tree;
    if (!tree) {
      viewport.textContent = '';
      nodes = [];
      renderCrumbs();
      return;
    }
    const root = state.focusKey !== null ? byKey.get(state.focusKey) : tree;
    const layout = currentLayout();
    $('layout').value = layout;

    const result = R.render(viewport, root, {
      layout,
      maxNodeWidth: config.maxNodeWidth,
      collapsed: state.collapsed,
      forceOpen: searchForceOpen(),
      nativeTitle: false, // メモは独自ツールチップで表示するため、標準のツールチップは出さない
    });
    nodes = result.nodes;
    bounds = result.bounds;

    renderCrumbs();
    applyActive();
    applySearchClasses();
    if (needsFit) {
      needsFit = false;
      fit();
    } else {
      applyTransform();
    }
  }

  function applyActive() {
    let best = null;
    for (const n of nodes) {
      if (n.line >= 0 && n.line <= cursorLine && (!best || n.line > best.line)) best = n;
    }
    for (const n of nodes) n.el.classList.toggle('active', n === best);
  }

  // ---------- focus (drill down) ----------
  function setFocus(key) {
    state.focusKey = key === '' ? null : key;
    saveState();
    needsFit = true;
    if (search.open) runSearch(false);
    render();
  }

  function renderCrumbs() {
    const crumbs = $('crumbs');
    crumbs.textContent = '';
    const focus = state.focusKey !== null && byKey.get(state.focusKey);
    crumbs.hidden = !focus;
    if (!focus) return;
    const path = [];
    for (let n = focus; n; n = n.parent) path.unshift(n);
    path.forEach((n, i) => {
      if (i > 0) crumbs.append(' › ');
      const b = document.createElement('button');
      b.textContent = i === 0 ? `⌂ ${n.text}` : n.text;
      b.dataset.focus = n.key;
      b.disabled = i === path.length - 1;
      crumbs.append(b);
    });
  }

  $('crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) setFocus(b.dataset.focus);
  });

  // ---------- search ----------
  function isInFocus(n) {
    if (state.focusKey === null) return true;
    for (let p = n; p; p = p.parent) if (p.key === state.focusKey) return true;
    return false;
  }

  function searchForceOpen() {
    const open = new Set();
    for (const n of search.matches) for (let p = n.parent; p; p = p.parent) open.add(p.key);
    return open;
  }

  function runSearch(reveal = true) {
    const q = search.query.trim().toLowerCase();
    search.matches = q
      ? [...byKey.values()].filter(
          (n) => isInFocus(n) && (n.text.toLowerCase().includes(q) || (n.note || '').toLowerCase().includes(q))
        )
      : [];
    search.index = 0;
    render();
    if (reveal) revealMatch();
  }

  function applySearchClasses() {
    const active = search.open && search.query.trim() !== '';
    const current = search.matches[search.index];
    for (const n of nodes) {
      const hit = search.matches.includes(n);
      n.el.classList.toggle('match', active && hit);
      n.el.classList.toggle('current-match', active && n === current);
      n.el.classList.toggle('dim', active && !hit);
    }
    $('search-count').textContent = active
      ? search.matches.length ? `${search.index + 1} / ${search.matches.length}` : '0 件'
      : '';
  }

  function revealMatch() {
    const n = search.matches[search.index];
    applySearchClasses();
    if (!n || n.x === undefined) return;
    transform = { ...transform, x: svg.clientWidth / 2 - n.x * transform.k, y: svg.clientHeight / 2 - n.y * transform.k };
    applyTransform();
  }

  function stepMatch(delta) {
    if (!search.matches.length) return;
    search.index = (search.index + delta + search.matches.length) % search.matches.length;
    revealMatch();
  }

  function openSearch() {
    search.open = true;
    $('search').hidden = false;
    $('search-input').focus();
    $('search-input').select();
    if (search.query) runSearch();
  }

  function closeSearch() {
    search.open = false;
    search.matches = [];
    $('search').hidden = true;
    render();
  }

  $('search-input').addEventListener('input', (e) => {
    search.query = e.target.value;
    runSearch();
  });
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') stepMatch(e.shiftKey ? -1 : 1);
    else if (e.key === 'Escape') closeSearch();
    e.stopPropagation();
  });
  $('search-prev').addEventListener('click', () => stepMatch(-1));
  $('search-next').addEventListener('click', () => stepMatch(1));
  $('search-close').addEventListener('click', closeSearch);

  // ---------- pan & zoom ----------
  function applyTransform() {
    viewport.setAttribute('transform', `translate(${transform.x},${transform.y}) scale(${transform.k})`);
    saveState();
  }

  function zoomAt(cx, cy, factor) {
    const k = Math.min(5, Math.max(0.1, transform.k * factor));
    const r = k / transform.k;
    transform = { x: cx - (cx - transform.x) * r, y: cy - (cy - transform.y) * r, k };
    applyTransform();
  }

  function fit() {
    if (!isFinite(bounds.minX)) return;
    const pad = 32;
    const top = 56; // ツールバーの下から表示する
    const vw = svg.clientWidth;
    const vh = svg.clientHeight - top;
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const k = Math.max(0.1, Math.min(1.5, (vw - pad * 2) / bw, (vh - pad * 2) / bh));
    transform = { k, x: vw / 2 - (bounds.minX + bw / 2) * k, y: top + vh / 2 - (bounds.minY + bh / 2) * k };
    applyTransform();
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  let drag = null;
  let lastClick = { key: null, time: 0 };
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, tx: transform.x, ty: transform.y, moved: false, target: e.target };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) {
      updateTooltip(e);
      return;
    }
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    hideTooltip();
    svg.classList.add('dragging');
    transform = { ...transform, x: drag.tx + dx, y: drag.ty + dy };
    applyTransform();
  });
  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    const { moved, target } = drag;
    drag = null;
    svg.classList.remove('dragging');
    if (!moved && target instanceof Element) onClick(target);
  });
  svg.addEventListener('pointerleave', hideTooltip);

  function onClick(target) {
    const link = target.closest('[data-href]');
    if (link) {
      vscode.postMessage({ type: 'openLink', href: link.getAttribute('data-href') });
      return;
    }
    const check = target.closest('[data-check]');
    if (check) {
      vscode.postMessage({ type: 'toggleCheck', line: Number(check.getAttribute('data-check')) });
      return;
    }
    const toggle = target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.getAttribute('data-toggle');
      if (state.collapsed[key]) delete state.collapsed[key];
      else state.collapsed[key] = true;
      saveState();
      render();
      return;
    }
    const nodeEl = target.closest('.node');
    if (!nodeEl) return;
    const key = nodeEl.getAttribute('data-key');
    const now = Date.now();
    if (lastClick.key === key && now - lastClick.time < 400) {
      // ダブルクリック → その枝にフォーカス
      lastClick = { key: null, time: 0 };
      setFocus(key);
      return;
    }
    lastClick = { key, time: now };
    vscode.postMessage({ type: 'reveal', line: Number(nodeEl.getAttribute('data-line')) });
  }

  // ---------- note tooltip ----------
  function updateTooltip(e) {
    const nodeEl = e.target instanceof Element && e.target.closest('.node');
    const n = nodeEl && byKey.get(nodeEl.getAttribute('data-key'));
    if (!n || !n.note) return hideTooltip();
    const tip = $('tooltip');
    tip.textContent = n.note;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(e.clientY + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTooltip() {
    $('tooltip').hidden = true;
  }

  // ---------- export ----------
  function buildExportSvg() {
    const margin = 24;
    const x = bounds.minX - margin;
    const y = bounds.minY - margin;
    const w = bounds.maxX - bounds.minX + margin * 2;
    const h = bounds.maxY - bounds.minY + margin * 2;
    const out = svg.cloneNode(true);
    out.removeAttribute('id');
    out.removeAttribute('class');
    out.setAttribute('xmlns', R.SVG_NS);
    out.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    out.setAttribute('width', String(Math.ceil(w)));
    out.setAttribute('height', String(Math.ceil(h)));
    const vp = out.querySelector('#viewport');
    vp.removeAttribute('transform');
    vp.removeAttribute('id');
    out.querySelectorAll('.toggle').forEach((t) => t.remove());
    out.querySelectorAll('[class]').forEach((t) => t.removeAttribute('class'));
    const bg = document.createElementNS(R.SVG_NS, 'rect');
    for (const [k, v] of Object.entries({ x, y, width: w, height: h, fill: R.theme().bg })) bg.setAttribute(k, String(v));
    out.insertBefore(bg, out.firstChild);
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out);
  }

  function svgToPng(svgText, scale = 2) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(img.width * scale);
        canvas.height = Math.ceil(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG への変換に失敗しました'))), 'image/png');
      };
      img.onerror = () => reject(new Error('SVG の読み込みに失敗しました'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }

  let toastTimer;
  function toast(message) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2000);
  }

  async function exportPng() {
    try {
      const blob = await svgToPng(buildExportSvg());
      vscode.postMessage({ type: 'exportPng', data: await blobToBase64(blob) });
    } catch (err) {
      toast(String(err.message || err));
    }
  }

  async function copyPng() {
    try {
      const blob = await svgToPng(buildExportSvg());
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('画像をクリップボードにコピーしました');
    } catch (err) {
      toast(`コピーに失敗しました: ${err.message || err}`);
    }
  }

  // ---------- toolbar & keys ----------
  const actions = {
    zoomIn: () => zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 1.25),
    zoomOut: () => zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, 0.8),
    fit,
    expandAll: () => {
      state.collapsed = {};
      saveState();
      render();
    },
    collapseAll: () => {
      state.collapsed = {};
      for (const n of nodes) if (n.depth === 1 && n.children.length) state.collapsed[n.key] = true;
      saveState();
      needsFit = true;
      render();
    },
    search: openSearch,
    exportSvg: () => tree && vscode.postMessage({ type: 'exportSvg', svg: buildExportSvg() }),
    exportPng: () => tree && exportPng(),
    copyPng: () => tree && copyPng(),
  };

  $('toolbar').addEventListener('click', (e) => {
    const btn = e.target instanceof Element && e.target.closest('button[data-action]');
    if (btn) actions[btn.getAttribute('data-action')]();
  });

  $('layout').addEventListener('change', (e) => {
    const fromFile = (tree && tree.layout) || config.layout;
    state.layoutOverride = e.target.value === fromFile ? null : e.target.value;
    needsFit = true;
    saveState();
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      // フォーカス中なら 1 階層上へ
      const focus = state.focusKey !== null && byKey.get(state.focusKey);
      if (focus) setFocus(focus.parent ? focus.parent.key : '');
    } else if (e.key === 'f' || e.key === 'F') fit();
    else if (e.key === '+' || e.key === '=') actions.zoomIn();
    else if (e.key === '-') actions.zoomOut();
  });

  // テーマ変更時に再描画（VS Code は body の class を書き換える）
  new MutationObserver(() => render()).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  vscode.postMessage({ type: 'ready' });
})();
