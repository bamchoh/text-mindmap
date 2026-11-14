// Markdown プレビュー内の ```mindmap ブロックを描画する
(function () {
  'use strict';

  // 注意点:
  // - Markdown プレビューはスクリプトを async で読み込むため、renderer.js が先に実行されるとは限らない。
  //   描画のたびに参照し、まだ読み込まれていなければ少し待って再試行する。
  // - 本文の挿入は vscode.markdown.updateContent イベントを伴わない場合があるため、
  //   イベントに頼らず DOM の変化を監視して、未描画のブロックを見つけたら描画する。
  let retries = 0;
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderAll();
    });
  }

  function renderAll() {
    const R = window.MindmapRenderer;
    if (!R) {
      if (retries++ < 100) setTimeout(renderAll, 50);
      return;
    }
    for (const el of document.querySelectorAll('.mindmap-embed')) {
      const source = el.getAttribute('data-mindmap');
      if (el.getAttribute('data-rendered') === source && el.firstChild) continue;
      el.setAttribute('data-rendered', source);
      el.textContent = '';

      let data;
      try {
        data = JSON.parse(source);
      } catch {
        continue;
      }
      if (!data.tree) {
        el.textContent = '（空のマインドマップ）';
        continue;
      }

      const svg = document.createElementNS(R.SVG_NS, 'svg');
      const g = document.createElementNS(R.SVG_NS, 'g');
      svg.appendChild(g);
      el.appendChild(svg);

      R.annotate(data.tree);
      const { bounds } = R.render(g, data.tree, {
        layout: data.tree.layout || data.layout,
        maxNodeWidth: data.maxNodeWidth,
      });
      const m = 16;
      const w = bounds.maxX - bounds.minX + m * 2;
      const h = bounds.maxY - bounds.minY + m * 2;
      svg.setAttribute('viewBox', `${bounds.minX - m} ${bounds.minY - m} ${w} ${h}`);
      svg.setAttribute('width', String(Math.ceil(w)));
      svg.setAttribute('height', String(Math.ceil(h)));
      // 折りたたみボタンは Markdown プレビューでは使わない
      svg.querySelectorAll('.toggle').forEach((t) => t.remove());
    }
  }

  window.addEventListener('vscode.markdown.updateContent', schedule);
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-mindmap', 'data-rendered'],
  });
  schedule();
})();
