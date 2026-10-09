/*
 * To Are.na · shared helpers for the export scripts: the panel (progress and picker), delivery
 * to the To Are.na tab, file download, pacing.
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

  /*
   * Hands the export to the To Are.na tab that opened this site. A short handshake first checks
   * that this tab really is the tool, at its exact address; only then does the data go. Without
   * it (site opened by hand, tool opened from a file), the export is downloaded instead.
   */
  async function deliver(data, filename, toolOrigin) {
    const opener = typeof window !== 'undefined' ? window.opener : null;
    if (opener && !opener.closed && /^https?:\/\/[^/]+$/.test(toolOrigin || '')) {
      const ready = await new Promise((resolve) => {
        const finish = (value) => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(value);
        };
        const onMessage = (e) => {
          if (e.origin === toolOrigin && e.source === opener && e.data?.type === 'to-arena/ready') finish(true);
        };
        const timer = setTimeout(() => finish(false), 2000);
        window.addEventListener('message', onMessage);
        try {
          opener.postMessage({ type: 'to-arena/hello' }, toolOrigin);
        } catch {
          finish(false);
        }
      });
      if (ready) {
        opener.postMessage({ type: 'to-arena/export', filename, data }, toolOrigin);
        try {
          opener.focus();
        } catch {
          /* the browser decides which tab comes forward */
        }
        return 'sent';
      }
    }
    download(data, filename);
    return 'downloaded';
  }

  /*
   * The panel: in the corner of the page, isolated in a shadow root so the site's styles can't
   * reach it, or inside `mount` (the demo). It shows progress, and the list to pick from.
   */
  function createOverlay(title, { mount } = {}) {
    document.getElementById('to-arena-export')?.remove();
    const host = document.createElement('div');
    host.id = 'to-arena-export';
    host.style.cssText = mount ? 'display:block;' : 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    /* Constructed style sheet: unlike a <style> tag, a site's security policy doesn't block it. */
    const css = `
        :host{all:initial}
        .box{width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-sizing:border-box;
          padding:16px;background:#fff;color:#333;border:1px solid #e5e5e5;border-radius:3px;
          font:400 15px/20px Arial,"Helvetica Neue",Helvetica,sans-serif;-webkit-font-smoothing:antialiased;text-align:left}
        .head{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;font-weight:700;font-size:16px}
        .status{min-height:20px;word-break:break-word}
        .count{color:#696969;font-size:13px;line-height:18px;font-variant-numeric:tabular-nums}
        .bar{height:4px;margin-top:12px;background:#f7f7f7;border-radius:2px;overflow:hidden;flex:none}
        .bar i{display:block;height:100%;width:0;background:#000}
        .error{color:#b42318}
        button{font:inherit;cursor:pointer}
        .close{border:0;background:none;padding:0;color:#696969;font-size:18px;line-height:20px}
        .btn{height:34px;padding:0 16px;border:0;border-radius:3px;background:#f7f7f7;color:#333;font-weight:700}
        .btn:hover{background:#ededed}
        .primary{background:#01075b;color:#fff;width:100%;margin-top:12px}
        .primary:hover{background:#01075b;opacity:.92}
        .primary:disabled{background:#f7f7f7;color:#696969;opacity:1;cursor:default}
        .actions{margin-top:12px}
        .pick{display:flex;flex-direction:column;min-height:0;margin-top:8px}
        .filter{height:32px;padding:0 10px;margin-bottom:8px;border:1px solid #e5e5e5;border-radius:0;font:inherit;color:#333}
        .links{display:flex;gap:12px;margin-bottom:6px;font-size:13px}
        .link{border:0;background:none;padding:0;color:#696969;text-decoration:underline;text-underline-offset:3px}
        .link:hover{color:#333}
        ul{list-style:none;margin:0;padding:0;overflow:auto;max-height:min(46vh,360px);border-top:1px solid #ededed}
        li label,.extra{display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid #ededed;cursor:pointer}
        li.child label{padding-left:22px}
        input[type=checkbox]{margin:3px 0 0;flex:none;accent-color:#333}
        .name{display:block}
        .meta{display:block;color:#696969;font-size:13px;line-height:18px}
        .extra{border-bottom:0;margin-top:4px}
        button:focus-visible,input:focus-visible{outline:2px solid #01075b;outline-offset:2px}
    `;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
    }
    const template = document.createElement('template');
    template.innerHTML = `
      <div class="box" role="dialog" aria-label="To Are.na export">
        <div class="head"><span id="title"></span><button class="close" id="close" aria-label="Close">×</button></div>
        <div class="status" id="status" role="status" aria-live="polite"></div>
        <div class="count" id="count"></div>
        <div class="bar" id="barwrap"><i id="bar"></i></div>
        <div id="body"></div>
      </div>`;
    root.appendChild(template.content);
    (mount || document.body).appendChild(host);
    const $ = (id) => root.getElementById(id);
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    $('title').textContent = title;
    let cancelPick = null;
    $('close').onclick = () => {
      host.remove();
      cancelPick?.();
    };

    return {
      status(text, progress = null, detail = '') {
        $('status').textContent = text;
        $('count').textContent = detail;
        $('barwrap').hidden = false;
        if (progress != null) $('bar').style.width = `${Math.min(100, Math.round(progress * 100))}%`;
      },

      /*
       * Lists what can be sent; resolves with the ticked ids (and the extra option) when the
       * person presses the button, rejects when they close the panel.
       */
      pick({ heading, items, noun, extra = null }) {
        $('status').textContent = heading;
        $('count').textContent = '';
        $('barwrap').hidden = true;
        return new Promise((resolve, reject) => {
          cancelPick = () => reject(Object.assign(new Error('Closed'), { cancelled: true }));
          const wrap = el('div', { className: 'pick' });
          const list = el('ul');
          const boxes = [];
          for (const item of items) {
            const li = el('li', { className: item.child ? 'child' : '' });
            const label = el('label');
            const box = el('input', { type: 'checkbox', checked: !!item.checked });
            box.dataset.id = item.id;
            const text = el('span');
            text.append(el('span', { className: 'name', textContent: item.name }), el('span', { className: 'meta', textContent: item.meta || '' }));
            label.append(box, text);
            li.appendChild(label);
            li.dataset.name = String(item.name || '').toLowerCase();
            list.appendChild(li);
            boxes.push(box);
          }
          const send = el('button', { className: 'btn primary', type: 'button' });
          const update = () => {
            const n = boxes.filter((b) => b.checked).length;
            send.disabled = !n && !extraBox?.checked;
            send.textContent = n ? `Send ${count(n, noun)} to Are.na` : extraBox?.checked ? 'Send to Are.na' : `Pick at least one ${noun}`;
          };
          list.addEventListener('change', update);
          if (items.length > 8) {
            const filter = el('input', { className: 'filter', type: 'search', placeholder: 'Filter' });
            filter.setAttribute('aria-label', 'Filter');
            filter.addEventListener('input', () => {
              const q = filter.value.trim().toLowerCase();
              for (const li of list.children) li.hidden = q && !li.dataset.name.includes(q);
            });
            wrap.appendChild(filter);
          }
          const links = el('div', { className: 'links' });
          const setAll = (checked) => {
            for (const b of boxes) if (!b.closest('li').hidden) b.checked = checked;
            update();
          };
          const all = el('button', { className: 'link', type: 'button', textContent: 'Select all' });
          const none = el('button', { className: 'link', type: 'button', textContent: 'Select none' });
          all.onclick = () => setAll(true);
          none.onclick = () => setAll(false);
          links.append(all, none);
          wrap.append(links, list);
          let extraBox = null;
          if (extra) {
            const label = el('label', { className: 'extra' });
            extraBox = el('input', { type: 'checkbox', checked: !!extra.checked });
            extraBox.addEventListener('change', update);
            label.append(extraBox, el('span', { textContent: extra.label }));
            wrap.appendChild(label);
          }
          send.onclick = () => {
            cancelPick = null;
            $('body').replaceChildren();
            resolve({ ids: boxes.filter((b) => b.checked).map((b) => b.dataset.id), extra: !!extraBox?.checked });
          };
          wrap.appendChild(send);
          $('body').replaceChildren(wrap);
          update();
        });
      },

      done(text, detail = '', again = null) {
        $('status').textContent = text;
        $('count').textContent = detail;
        $('barwrap').hidden = false;
        $('bar').style.width = '100%';
        $('body').replaceChildren();
        if (again) {
          const button = el('button', { className: 'btn', type: 'button', textContent: 'Download again' });
          button.onclick = again;
          const actions = el('div', { className: 'actions' });
          actions.appendChild(button);
          $('body').appendChild(actions);
        }
      },

      error(text) {
        $('status').replaceChildren(el('span', { className: 'error', textContent: text }));
        $('barwrap').hidden = true;
        $('body').replaceChildren();
      },
    };
  }

  return { sleep, safeName, count, download, deliver, createOverlay };
}

if (typeof module !== 'undefined') module.exports = { exportKit };
