/*
 * To Are.na · demo. Plugs simulated services into the real page (window.TO_ARENA_DEMO, read by
 * app.js): a Pinterest or Cosmos “site” in a window where the real export script runs, an Are.na
 * consent screen, an in-memory Are.na, and a view of the channels it ends up with.
 */
(() => {
  'use strict';

  const M = window.ToArenaMocks;
  const T = window.ToArena;
  const arena = M.arenaApi();
  const SITES = {
    pinterest: { name: 'Pinterest', host: 'pinterest.com', origin: 'https://www.pinterest.com', data: M.pinterestData() },
    cosmos: { name: 'Cosmos', host: 'cosmos.so', origin: 'https://www.cosmos.so', data: M.cosmosData() },
  };
  SITES.pinterest.fetch = M.pinterestApi(SITES.pinterest.data);
  SITES.cosmos.fetch = M.cosmosApi(SITES.cosmos.data);

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null));
    return node;
  };
  const img = (url, alt = '') => el('img', { src: M.placeholder(url), alt, loading: 'lazy' });
  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  /* A window over the page; Escape or × closes it. */
  function modal(className, title, { onClose } = {}) {
    const overlay = el('div', { className: 'demo-modal' });
    const box = el('div', { className: `demo-window ${className}` });
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      onClose?.();
    };
    const onKey = (e) => e.key === 'Escape' && close();
    const bar = el('div', { className: 'demo-window__bar' }, el('span', { className: 'demo-window__dots', ariaHidden: 'true' }), el('span', { className: 'demo-window__url', textContent: title }));
    const x = el('button', { type: 'button', className: 'demo-window__close', textContent: '×', ariaLabel: 'Close' });
    x.addEventListener('click', close);
    bar.appendChild(x);
    box.appendChild(bar);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    x.focus();
    return { box, close, setTitle: (text) => (bar.querySelector('.demo-window__url').textContent = text) };
  }

  /* ───────────── The simulated site, with the real export script ───────────── */

  function openSource(source, { receive }) {
    const site = SITES[source];
    const isPinterest = source === 'pinterest';
    const user = isPinterest ? site.data.username : site.data.me.username;
    let path = `/${user}/`;
    let running = false;
    const win = modal('demo-site-window', `${site.host}${path} · simulated`);

    const page = el('div', { className: 'demo-site' });
    const aside = el('aside', { className: 'demo-script' });
    const where = el('p', { className: 'demo-script__where' });
    const run = el('button', { type: 'button', className: 'btn btn--primary', textContent: 'Run the script' });
    const mount = el('div', { className: 'demo-script__panel' });
    aside.append(
      el('p', {
        className: 'demo-script__how',
        textContent: isPinterest
          ? 'On pinterest.com, this is when you open the console and paste the script.'
          : 'On cosmos.so, this is when you click your “Send to Are.na” bookmark.',
      }),
      where,
      run,
      mount
    );
    win.box.appendChild(el('div', { className: 'demo-window__body' }, page, aside));

    const setPath = (next) => {
      path = next;
      win.setTitle(`${site.host}${path} · simulated`);
      const onCollection = path.split('/').filter(Boolean).length > 1;
      const noun = isPinterest ? 'board' : 'collection';
      where.textContent = onCollection
        ? `You’re on a ${noun}: the script sends just this one, with its ${isPinterest ? 'sections' : 'sub-collections'}.`
        : `You’re on the profile: the script lets you pick ${noun}s. Or open one first.`;
    };

    const tile = (cover, name, meta, onClick) => {
      const button = el('button', { type: 'button', className: 'demo-tile' }, el('span', { className: 'demo-tile__img' }, img(cover)), el('span', { className: 'demo-tile__name', textContent: name }), el('span', { className: 'demo-tile__meta', textContent: meta }));
      button.addEventListener('click', onClick);
      return button;
    };

    function showProfile() {
      setPath(`/${user}/`);
      const collections = isPinterest
        ? site.data.boards.map((b) => ({ key: b.slug, name: b.name, cover: b.pins[0].images.orig.url, meta: `${count(b.pins.length + b.sections.reduce((n, s) => n + s.pins.length, 0), 'pin')}${b.secret ? ' · secret' : ''}`, open: () => showCollection(b) }))
        : site.data.clusters.filter((c) => !c.parent).map((c) => ({ key: c.slug, name: c.name, cover: c.elements[0].media.url, meta: `${count(c.elements.length, 'item')}${c.isPrivate ? ' · private' : ''}`, open: () => showCollection(c) }));
      page.replaceChildren(
        el('div', { className: 'demo-profile' }, el('span', { className: 'avatar', textContent: 'DS' }), el('div', {}, el('strong', { textContent: 'Demo Studio' }), el('span', { className: 'demo-tile__meta', textContent: ` @${user}` }))),
        el('p', { className: 'demo-site__label', textContent: isPinterest ? 'Boards' : 'Collections' }),
        el('div', { className: 'demo-grid' }, ...collections.map((c) => tile(c.cover, c.name, c.meta, c.open)))
      );
    }

    function showCollection(c) {
      setPath(`/${user}/${c.slug}${isPinterest ? '/' : ''}`);
      const items = isPinterest ? [...c.pins, ...c.sections.flatMap((s) => s.pins)].map((p) => ({ url: p.images.orig.url, title: p.title })) : c.elements.map((e) => ({ url: e.media.url, title: e.generatedCaption.text }));
      const back = el('button', { type: 'button', className: 'link', textContent: '← Demo Studio' });
      back.addEventListener('click', showProfile);
      page.replaceChildren(
        back,
        el('h3', { className: 'demo-site__title', textContent: c.name }),
        el('div', { className: 'demo-masonry' }, ...items.map((i) => el('figure', {}, img(i.url, i.title))))
      );
    }

    run.addEventListener('click', async () => {
      if (running) return;
      running = true;
      run.disabled = true;
      const env = {
        origin: site.origin,
        path,
        fetch: site.fetch,
        mount,
        toolOrigin: location.origin,
        deliver: async (data, filename) => {
          setTimeout(() => {
            win.close();
            receive(data, filename);
          }, 1500);
          return 'sent';
        },
        ...(isPinterest ? {} : { anonymous: true, me: site.data.me }),
      };
      await (isPinterest ? window.pinterestExport : window.cosmosExport)(env, window.exportKit());
      running = false;
      run.disabled = false;
    });

    showProfile();
  }

  /* ───────────── Are.na consent ───────────── */

  function authorize() {
    return new Promise((resolve, reject) => {
      let answered = false;
      const win = modal('demo-consent', 'are.na/oauth/authorize · simulated', {
        onClose: () => !answered && reject(Object.assign(new Error('Closed'), { cancelled: true })),
      });
      const allow = el('button', { type: 'button', className: 'btn btn--primary', textContent: 'Allow' });
      const deny = el('button', { type: 'button', className: 'btn', textContent: 'Cancel' });
      allow.addEventListener('click', () => {
        answered = true;
        win.close();
        resolve('demo-token');
      });
      deny.addEventListener('click', () => win.close());
      win.box.appendChild(
        el(
          'div',
          { className: 'demo-consent__body' },
          el('p', { className: 'demo-consent__app', textContent: 'To Are.na' }),
          el('p', { textContent: 'would like to read your channels, and create channels and blocks on your Are.na account.' }),
          el('p', { className: 'hint', textContent: 'On the real site, you would sign in to Are.na first if needed.' }),
          el('div', { className: 'actions' }, allow, deny)
        )
      );
      allow.focus();
    });
  }

  /* ───────────── The result, as Are.na would show it ───────────── */

  function blockView(entry) {
    if (entry.type === 'Channel') {
      return el('div', { className: 'ar-block ar-block--channel' }, el('div', { className: 'ar-block__frame' }, el('span', { textContent: entry.channel.title }), el('span', { className: 'demo-tile__meta', textContent: 'Channel' })), el('p', { className: 'ar-block__caption', textContent: entry.channel.title }));
    }
    const b = entry.block;
    if (entry.type === 'Text') {
      return el('div', { className: 'ar-block ar-block--text' }, el('div', { className: 'ar-block__frame', textContent: b.value }));
    }
    const url = entry.type === 'Link' ? b.cover : b.value;
    const frame = el('div', { className: 'ar-block__frame' }, url ? img(url, b.title) : el('span', { textContent: b.title }));
    if (entry.type === 'Attachment') frame.appendChild(el('span', { className: 'demo-badge', textContent: 'Video' }));
    if (entry.type === 'Original') frame.appendChild(el('span', { className: 'demo-badge', textContent: 'Connected original' }));
    if (entry.type === 'Link') frame.appendChild(el('span', { className: 'demo-badge', textContent: 'Link' }));
    return el('div', { className: 'ar-block' }, frame, el('p', { className: 'ar-block__caption', textContent: b.title || '' }));
  }

  function showResult() {
    const channels = [...arena.state.channels.values()];
    const win = modal('demo-arena', 'are.na/you · simulated');
    const nav = el('ul', { className: 'demo-arena__nav' });
    const main = el('div', { className: 'demo-arena__main' });
    win.box.appendChild(el('div', { className: 'demo-window__body demo-arena__body' }, nav, main));
    const show = (channel) => {
      for (const li of nav.children) li.toggleAttribute('aria-current', li.dataset.id === String(channel.id));
      const entries = arena.contents(channel.id);
      main.replaceChildren(
        el('h3', { className: 'crumb demo-arena__crumb' }, el('span', { textContent: 'You' }), el('span', { className: 'crumb__sep', textContent: '/' }), el('span', { className: 'crumb__current', textContent: channel.title })),
        el('p', { className: 'meta', textContent: `${count(entries.length, 'block')} · ${channel.visibility}` }),
        el('div', { className: 'ar-grid' }, ...entries.map(blockView))
      );
    };
    for (const channel of channels) {
      const li = el('li');
      li.dataset.id = channel.id;
      const button = el('button', { type: 'button', textContent: channel.title });
      button.addEventListener('click', () => show(channel));
      li.appendChild(button);
      nav.appendChild(li);
    }
    if (channels.length) show(channels[0]);
    else main.appendChild(el('p', { textContent: 'No channel yet: run a transfer first.' }));
  }

  window.TO_ARENA_DEMO = {
    openSource,
    authorize,
    showResult,
    image: (url) => (M.isDemoUrl(url) ? M.placeholder(url) : null),
    makeClient: (token, opts = {}) => new T.ArenaClient(token, { ...opts, fetchImpl: arena.fetchImpl, writeGap: 45 }),
  };
})();
