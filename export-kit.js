/*
 * To Are.na · shared helpers for the export scripts: progress panel, file download, pacing.
 *
 * app.js inlines this function into every bookmarklet and console script, next to the
 * exporter itself, so it must stay self-contained (no imports, no outside variables).
 */
function exportKit() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* Lowercase, dashes only: safe in a file name whatever the account name holds. */
  const safeName = (value) =>
    String(value || 'export')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'export';

  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  function download(data, filename) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 1000);
  }

  /* A small panel in the corner of the page, isolated in a shadow root so the site's styles can't reach it. */
  function createOverlay(title) {
    document.getElementById('to-arena-export')?.remove();
    const host = document.createElement('div');
    host.id = 'to-arena-export';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box{width:min(360px,calc(100vw - 32px));box-sizing:border-box;padding:16px;background:#fff;color:#333;
          border:1px solid #e5e5e5;border-radius:3px;font:400 15px/20px "ABC Areal","Helvetica Neue",Helvetica,Arial,sans-serif;
          -webkit-font-smoothing:antialiased}
        .head{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:700;font-size:16px}
        .status{min-height:20px;word-break:break-word}
        .count{color:#696969;font-size:13px;line-height:18px;font-variant-numeric:tabular-nums}
        .bar{height:4px;margin-top:12px;background:#f7f7f7;border-radius:2px;overflow:hidden}
        .bar i{display:block;height:100%;width:0;background:#000}
        .error{color:#b42318}
        button{font:inherit;cursor:pointer}
        .close{border:0;background:none;padding:0;color:#696969;font-size:16px}
        .again{margin-top:12px;height:34px;padding:0 16px;border:0;border-radius:3px;background:#f7f7f7;color:#333;font-weight:700}
        .again:hover{background:#ededed}
        button:focus-visible{outline:2px solid #01075b;outline-offset:2px}
      </style>
      <div class="box" role="status" aria-live="polite">
        <div class="head"><span id="title"></span><button class="close" id="close" aria-label="Close">×</button></div>
        <div class="status" id="status"></div>
        <div class="count" id="count"></div>
        <div class="bar"><i id="bar"></i></div>
        <div id="actions"></div>
      </div>`;
    document.body.appendChild(host);
    const $ = (id) => root.getElementById(id);
    $('title').textContent = title;
    $('close').onclick = () => host.remove();
    return {
      status(text, progress = null, count = '') {
        $('status').textContent = text;
        $('count').textContent = count;
        if (progress != null) $('bar').style.width = `${Math.min(100, Math.round(progress * 100))}%`;
      },
      done(text, filename, again) {
        $('status').textContent = text;
        $('count').textContent = `Saved as ${filename}`;
        $('bar').style.width = '100%';
        const button = document.createElement('button');
        button.className = 'again';
        button.textContent = 'Download again';
        button.onclick = again;
        $('actions').replaceChildren(button);
      },
      error(text) {
        const span = document.createElement('span');
        span.className = 'error';
        span.textContent = text;
        $('status').replaceChildren(span);
      },
    };
  }

  return { sleep, safeName, count, download, createOverlay };
}

if (typeof module !== 'undefined') module.exports = { exportKit };
