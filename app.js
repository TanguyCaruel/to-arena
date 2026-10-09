/* To Are.na · interface */
(() => {
  'use strict';

  const {
    ArenaClient,
    DryRunClient,
    AbortedError,
    FREE_TIER_LIMIT,
    SOURCES,
    buildPlan,
    checkWriteAccess,
    emptyJournal,
    normalizeExport,
    normalizeUrl,
    runImport,
  } = window.ToArena;

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('en-US');
  const n = (x) => nf.format(x);
  const plural = (count, one, many) => `${n(count)} ${count === 1 ? one : many}`;

  const TOKEN_KEY = 'to-arena:token';
  const LEGACY_TOKEN_KEY = 'cosmos-to-arena:token';
  /* Same key as the first versions, so their history keeps preventing duplicates. */
  const journalKey = (userId) => `cosmos-to-arena:journal:${userId}`;

  const WORDS = {
    cosmos: { collection: ['collection', 'collections'], item: ['item', 'items'], nest: 'Put sub-collections inside their parent channel' },
    pinterest: { collection: ['board', 'boards'], item: ['pin', 'pins'], nest: 'Put each section inside its board’s channel' },
  };
  const words = () => WORDS[state.source] || WORDS.cosmos;

  const store = {
    get(area, key) {
      try {
        return window[area].getItem(key);
      } catch {
        return null;
      }
    },
    set(area, key, value) {
      try {
        window[area].setItem(key, value);
      } catch {
        /* storage unavailable (private browsing): carry on without it */
      }
    },
    remove(area, key) {
      try {
        window[area].removeItem(key);
      } catch {
        /* same */
      }
    },
  };

  const state = {
    step: 'source',
    source: null,
    data: null,
    filename: '',
    selected: new Set(),
    me: null,
    journal: emptyJournal(),
    plan: null,
    run: null,
    lastOutcome: null,
  };
  /* Kept out of `state` (exposed for debugging below) so no other script can read it from there. */
  const session = { token: '' };
  const busy = () => !!state.run;

  /* ───────────── Steps ───────────── */

  const FLOW = [
    { id: 'source', label: 'Source', desc: 'Pick where your saves live.' },
    { id: 'export', label: 'Export', desc: 'Download your saves as a file, then add it here.' },
    { id: 'choose', label: 'Choose', desc: 'Select what to bring to Are.na.' },
    { id: 'connect', label: 'Connect', desc: 'Link your Are.na account and pick a few settings.' },
    { id: 'transfer', label: 'Transfer', desc: 'Review, simulate if you like, then create the channels.' },
  ];

  function reachable(id) {
    switch (id) {
      case 'source':
        return true;
      case 'export':
        return !!state.source;
      case 'choose':
        return !!state.data;
      case 'connect':
        return !!state.data;
      case 'transfer':
        return !!(state.data && state.me && state.plan?.stats.channels);
      default:
        return false;
    }
  }

  function go(id, { focus = true } = {}) {
    if (!reachable(id)) return;
    state.step = id;
    render();
    if (focus) {
      window.scrollTo({ top: 0 });
      document.querySelector(`.panel[data-step="${id}"] .heading`)?.focus({ preventScroll: true });
    }
  }

  function render() {
    const flow = FLOW;
    const index = flow.findIndex((s) => s.id === state.step);

    const crumb = $('crumb');
    crumb.replaceChildren();
    const current = state.source ? SOURCES[state.source].label : null;
    if (current) {
      const home = Object.assign(document.createElement('button'), { type: 'button', textContent: 'To Are.na' });
      home.addEventListener('click', goHome);
      crumb.append(
        home,
        Object.assign(document.createElement('span'), { className: 'crumb__sep', textContent: '/' }),
        Object.assign(document.createElement('span'), { className: 'crumb__current', textContent: current })
      );
    } else {
      crumb.append(Object.assign(document.createElement('span'), { className: 'crumb__current', textContent: 'To Are.na' }));
    }

    const steps = $('steps');
    steps.replaceChildren();
    for (const step of flow) {
      const li = document.createElement('li');
      const isCurrent = step.id === state.step;
      if (isCurrent) {
        li.setAttribute('aria-current', 'step');
        li.append(step.label, Object.assign(document.createElement('span'), { className: 'steps__desc', textContent: step.desc }));
      } else if (reachable(step.id)) {
        li.className = 'is-reachable';
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: step.label });
        button.addEventListener('click', () => go(step.id));
        li.appendChild(button);
      } else {
        li.textContent = step.label;
      }
      steps.appendChild(li);
    }
    const count = $('step-count');
    count.replaceChildren(`Step ${index + 1} of ${flow.length} · ${flow[index]?.label || ''}`);
    const previous = flow[index - 1];
    if (previous && reachable(previous.id)) {
      const back = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: `Back to ${previous.label}` });
      back.addEventListener('click', () => go(previous.id));
      count.append(' · ', back);
    }

    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.dataset.step !== state.step;
    for (const el of document.querySelectorAll('[data-only]')) el.hidden = el.dataset.only !== state.source;
    for (const choice of document.querySelectorAll('.choice')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.source === state.source));
    }
    $('nest-label').textContent = words().nest;

    if (!state.run) state.plan = state.data ? buildPlan(state.data, options()) : null;
    updateChoose();
    updateConnect();
    updateTransfer();
  }

  function goHome() {
    if (busy()) return;
    go('source');
  }

  $('home').addEventListener('click', goHome);

  for (const choice of document.querySelectorAll('.choice')) {
    choice.addEventListener('click', () => {
      const source = choice.dataset.source;
      if (state.data && state.data.source !== source) {
        state.data = null;
        state.selected = new Set();
        resetDrop();
      }
      state.source = source;
      go('export');
    });
  }

  for (const button of document.querySelectorAll('[data-next]')) {
    button.addEventListener('click', () => go(button.dataset.next));
  }

  /* ───────────── Export scripts ───────────── */

  /* Each script carries the shared kit, so it runs on its own in the bookmark or the console. */
  const scriptFor = (fn) => `(function () {\n${window.exportKit.toString()}\n(${fn.toString()})();\n})();`;
  const EXPORTERS = { cosmos: window.cosmosExport, pinterest: window.pinterestExport };

  for (const [source, fn] of Object.entries(EXPORTERS)) {
    const link = $(`bookmarklet-${source}`);
    link.href = `javascript:${encodeURIComponent(scriptFor(fn))}`;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      link.title = 'Drag this button to your bookmarks bar, then click it on the site.';
      const hint = document.querySelector(`[data-copied="${source}"]`);
      if (hint) hint.textContent = 'Drag the button to your bookmarks bar, then click it on the site.';
    });
  }

  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const text = scriptFor(EXPORTERS[button.dataset.copy]);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const area = Object.assign(document.createElement('textarea'), { value: text });
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      document.querySelector(`[data-copied="${button.dataset.copy}"]`).textContent = 'Copied';
    });
  }

  /* ───────────── Export file ───────────── */

  const drop = $('drop');
  $('file').addEventListener('change', (e) => e.target.files[0] && readFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  async function readFile(file) {
    const error = $('load-error');
    error.hidden = true;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('This file is too large to be an export.');
      loadExport(JSON.parse(await file.text()), file.name);
    } catch (err) {
      error.textContent = err instanceof SyntaxError ? 'This file isn’t valid JSON.' : err.message;
      error.hidden = false;
    }
  }

  function loadExport(raw, filename = 'export.json') {
    const data = normalizeExport(raw);
    state.data = data;
    state.filename = filename;
    state.source = data.source;
    state.selected = new Set(data.collections.filter((c) => !c.system).map((c) => c.id));
    $('drop-title').textContent = `✓ ${filename}`;
    $('include-library').checked = false;
    renderCollections();
    go('choose');
  }

  function resetDrop() {
    $('drop-title').textContent = 'Add your export file';
    $('file').value = '';
  }

  /* ───────────── Choose ───────────── */

  function renderCollections() {
    const { collections, user, exportedAt, elements, library } = state.data;
    const w = words();
    const date = new Date(exportedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    $('export-summary').textContent = `Export of @${user?.username || '?'} · ${date} · ${plural(collections.length, ...w.collection)} · ${plural(
      Object.keys(elements).length,
      ...w.item
    )}`;

    const ids = new Set(collections.map((c) => c.id));
    const children = new Map();
    for (const c of collections) {
      if (c.parentId && ids.has(c.parentId)) {
        if (!children.has(c.parentId)) children.set(c.parentId, []);
        children.get(c.parentId).push(c);
      }
    }
    const list = $('collections');
    list.replaceChildren();
    for (const c of collections.filter((c) => !c.parentId || !ids.has(c.parentId))) {
      list.appendChild(collectionRow(c, false, user));
      for (const child of children.get(c.id) || []) list.appendChild(collectionRow(child, true, user));
    }
    $('filter').value = '';

    $('library-row').hidden = !library;
    if (library) {
      $('library-meta').textContent = `${plural(library.elementIds.length, ...w.item)}, including those in no collection. Makes one more channel.`;
    }
  }

  function collectionRow(c, isChild, user) {
    const li = document.createElement('li');
    li.dataset.name = normalize(c.name);
    const label = document.createElement('label');
    label.className = `row${isChild ? ' row--child' : ''}`;

    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.selected.has(c.id) });
    box.dataset.id = c.id;

    const thumb = Object.assign(document.createElement('img'), { className: 'thumb', alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    const src = thumbUrl(c.cover);
    if (src) thumb.src = src;

    const text = Object.assign(document.createElement('span'), { className: 'row__text' });
    const meta = [plural(c.elementIds.length, ...words().item)];
    if (c.isPrivate) meta.push(state.source === 'pinterest' ? 'secret' : 'private');
    if (c.system) meta.push('public profile');
    if (c.owner && user?.username && c.owner !== user.username) meta.push(`with @${c.owner}`);
    text.append(
      Object.assign(document.createElement('span'), { className: 'row__name', textContent: c.name || 'Untitled' }),
      Object.assign(document.createElement('span'), { className: 'row__meta', textContent: meta.join(' · ') })
    );

    label.append(box, thumb, text);
    li.appendChild(label);
    return li;
  }

  /* Only the sources' own image hosts: a doctored export file can't make the page call anywhere else. */
  function thumbUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/^(cdn\.cosmos\.so|i\.pinimg\.com)$/.test(u.hostname)) return null;
      if (u.hostname === 'cdn.cosmos.so' && !u.search) {
        u.searchParams.set('format', 'webp');
        u.searchParams.set('w', '96');
      }
      return u.href;
    } catch {
      return null;
    }
  }

  const normalize = (s) =>
    (s || '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();

  $('collections').addEventListener('change', (e) => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    render();
  });

  $('filter').addEventListener('input', (e) => {
    const q = normalize(e.target.value.trim());
    for (const li of $('collections').children) li.hidden = q && !li.dataset.name.includes(q);
  });

  const setVisible = (checked) => {
    for (const li of $('collections').children) {
      if (li.hidden) continue;
      const box = li.querySelector('input');
      box.checked = checked;
      if (checked) state.selected.add(box.dataset.id);
      else state.selected.delete(box.dataset.id);
    }
    render();
  };
  $('select-all').addEventListener('click', () => setVisible(true));
  $('select-none').addEventListener('click', () => setVisible(false));
  $('include-library').addEventListener('change', render);

  function updateChoose() {
    if (!state.data) return;
    const count = state.selected.size + ($('include-library').checked ? 1 : 0);
    $('choose-count').textContent = count ? `${plural(state.selected.size, ...words().collection)} selected` : 'Nothing selected yet';
    document.querySelector('[data-next="connect"]').disabled = !count;
  }

  /* ───────────── Connect ───────────── */

  $('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    connect();
  });

  $('remember').addEventListener('change', () => {
    if (session.token) saveToken(session.token);
  });

  function saveToken(token) {
    const [keep, drop] = $('remember').checked ? ['localStorage', 'sessionStorage'] : ['sessionStorage', 'localStorage'];
    store.set(keep, TOKEN_KEY, token);
    store.remove(drop, TOKEN_KEY);
    store.remove('localStorage', LEGACY_TOKEN_KEY);
    store.remove('sessionStorage', LEGACY_TOKEN_KEY);
  }

  /* Checks the token, then that it can write: a read-only token would fail at the first channel. */
  async function connect() {
    const token = $('token').value.trim();
    if (!token || busy()) return;
    const button = $('connect');
    button.disabled = true;
    button.textContent = 'Checking…';
    $('token-error').hidden = true;
    try {
      const client = new ArenaClient(token);
      const me = await client.request('GET', '/me');
      if (!(await checkWriteAccess(client))) throw Object.assign(new Error('This token is read-only'), { readOnly: true });
      state.me = me;
      session.token = token;
      state.journal = loadJournal(me.id);
      saveToken(token);
      $('token').value = '';
    } catch (err) {
      state.me = null;
      session.token = '';
      forgetToken();
      showTokenError(err);
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
      render();
    }
  }

  function showTokenError(err) {
    const box = $('token-error');
    if (err.readOnly) {
      const link = Object.assign(document.createElement('a'), {
        href: 'https://www.are.na/settings/personal-access-tokens',
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: 'Create a token with read and write access →',
      });
      box.replaceChildren('This token can only read, so it can’t create channels. ', link, ', then paste it here.');
      $('token').value = '';
      $('token').focus();
    } else {
      box.textContent =
        err.status === 401 ? 'Are.na refused this token. Check that it is complete, or create a new one.' : `Can’t connect: ${err.message}`;
    }
    box.hidden = false;
  }

  function forgetToken() {
    for (const area of ['localStorage', 'sessionStorage']) {
      store.remove(area, TOKEN_KEY);
      store.remove(area, LEGACY_TOKEN_KEY);
    }
  }

  $('disconnect').addEventListener('click', () => {
    if (busy()) return;
    forgetToken();
    state.me = null;
    session.token = '';
    render();
  });

  function loadJournal(userId) {
    try {
      const j = JSON.parse(store.get('localStorage', journalKey(userId)));
      if (j?.v === 1) return { ...emptyJournal(), ...j };
    } catch {
      /* unreadable journal: start afresh, the run will find what exists on Are.na */
    }
    return emptyJournal();
  }

  const saveJournal = () => state.me && store.set('localStorage', journalKey(state.me.id), JSON.stringify(state.journal));

  $('forget-journal').addEventListener('click', () => {
    if (!state.me || busy()) return;
    const ok = window.confirm(
      'Forget the import history of this account? Channels already made stay on Are.na; the next transfer finds them again through their metadata.'
    );
    if (!ok) return;
    store.remove('localStorage', journalKey(state.me.id));
    state.journal = emptyJournal();
    render();
  });

  for (const id of ['visibility', 'carousel', 'arena-links', 'captions', 'credits', 'nest', 'image-mode']) $(id).addEventListener('change', render);

  $('connect-next').addEventListener('click', () => go('transfer'));

  const initials = (name) =>
    String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

  function updateConnect() {
    const { me, journal } = state;
    $('connect-form').hidden = !!me;
    $('account').hidden = !me;
    $('topbar-account').hidden = !me;
    if (me) {
      const name = me.name || me.slug;
      const tier = { free: 'free account', premium: 'Premium', supporter: 'Supporter' }[me.tier] || me.tier;
      $('account-avatar').textContent = $('topbar-avatar').textContent = initials(name);
      $('topbar-name').textContent = name;
      const already = Object.keys(journal.blocks).length;
      const text = $('account-text');
      text.replaceChildren('Signed in as ', Object.assign(document.createElement('strong'), { textContent: name }), ` · ${tier}`);
      if (already) text.append(` · ${plural(already, 'block', 'blocks')} imported from this browser`);
    }
    const next = $('connect-next');
    next.disabled = !(me && state.plan?.stats.channels);
  }

  /* ───────────── Transfer ───────────── */

  function options() {
    return {
      selected: [...state.selected],
      includeLibrary: $('include-library').checked,
      visibility: $('visibility').value,
      carousel: $('carousel').value,
      arenaLinks: $('arena-links').checked,
      nest: $('nest').checked,
      captions: $('captions').checked,
      credits: $('credits').checked,
    };
  }

  function updateTransfer() {
    const { me, run } = state;
    const start = $('start');
    const simulate = $('simulate');
    if (run) {
      start.disabled = false;
      start.textContent = run.dryRun ? 'Stop the simulation' : 'Pause';
      simulate.hidden = true;
      return;
    }
    simulate.hidden = false;
    if (!state.plan) return;

    const { stats } = state.plan;
    const writes = stats.channels + stats.connections + stats.nests;
    const minutes = Math.max(1, Math.round((writes * 0.75) / 60));
    const table = $('plan-table');
    table.replaceChildren();
    const row = (label, value) => {
      table.append(
        Object.assign(document.createElement('dt'), { textContent: label }),
        Object.assign(document.createElement('dd'), { textContent: value })
      );
    };
    row('Channels', n(stats.channels) + (stats.nests ? ` (${n(stats.nests)} inside another)` : ''));
    row('New blocks', n(stats.blocks));
    if (stats.reused) row('Extra connections, for items in several channels', n(stats.reused));
    if (stats.arena) row('Connections to Are.na originals', n(stats.arena));
    if (stats.skippedElements) row('Items without content, skipped', n(stats.skippedElements));
    row('Estimated time', `about ${n(minutes)} min, plus any pause Are.na asks for`);

    const warning = $('plan-warning');
    const total = stats.connections + stats.nests;
    warning.hidden = me?.tier !== 'free';
    if (me?.tier === 'free') {
      warning.replaceChildren(
        'A free Are.na account holds ',
        Object.assign(document.createElement('strong'), { textContent: `${FREE_TIER_LIMIT} blocks` }),
        ` in total. This transfer adds ${n(total)}`,
        total > FREE_TIER_LIMIT ? ', so it would stop partway: upgrade to Premium, or select less.' : ', on top of what you already have.'
      );
    }

    simulate.disabled = busy();
    start.disabled = !me || busy() || !stats.channels;
    start.textContent =
      state.lastOutcome === 'paused' ? 'Resume' : state.lastOutcome === 'failed' ? 'Retry failed items' : 'Transfer';
  }

  $('start').addEventListener('click', () => {
    if (state.run) state.run.controller.abort();
    else startRun(false);
  });
  $('simulate').addEventListener('click', () => startRun(true));

  /* ───────────── Progress view (transfer and fix) ───────────── */

  function createRunView(root) {
    const q = (key) => root.querySelector(`[data-run="${key}"]`);
    let waitTimer = null;
    return {
      reset(phase, { counters = true } = {}) {
        root.hidden = false;
        root.querySelector('.counters').hidden = !counters;
        q('phase').textContent = phase;
        q('count').textContent = '';
        q('wait').textContent = '';
        q('fill').style.width = '0%';
        for (const dd of root.querySelectorAll('[data-count]')) dd.textContent = '0';
        q('result').hidden = true;
        q('result').replaceChildren();
        q('log').replaceChildren();
      },
      phase(text) {
        q('phase').textContent = text;
      },
      progress(done, total, suffix = '') {
        const pct = total ? (done / total) * 100 : 0;
        q('fill').style.width = `${pct}%`;
        q('bar').setAttribute('aria-valuenow', String(Math.round(pct)));
        q('count').textContent = total ? `${n(done)} of ${n(total)}${suffix}` : '';
      },
      counts(values) {
        for (const dd of root.querySelectorAll('[data-count]')) dd.textContent = n(values[dd.dataset.count] || 0);
      },
      /* `until`: when Are.na's rate limit lifts (0 = resumed). Returns the length of the wait. */
      wait(until) {
        clearInterval(waitTimer);
        q('wait').textContent = '';
        if (!until) return 0;
        const tick = () => {
          const s = Math.max(0, Math.round((until - Date.now()) / 1000));
          const label = s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
          q('wait').textContent = `Are.na asks for a pause. Resuming by itself in ${label}; keep this tab open.`;
        };
        tick();
        waitTimer = setInterval(tick, 1000);
        return Math.max(0, until - Date.now());
      },
      stopWaiting() {
        clearInterval(waitTimer);
        q('wait').textContent = '';
      },
      log(level, message, url) {
        const list = q('log');
        const li = Object.assign(document.createElement('li'), { className: level });
        li.textContent = `${new Date().toLocaleTimeString('en-GB')}  ${message}`;
        const safe = normalizeUrl(url);
        if (safe) {
          li.append(' · ');
          li.appendChild(Object.assign(document.createElement('a'), { href: safe, target: '_blank', rel: 'noopener noreferrer', textContent: 'source' }));
        }
        list.appendChild(li);
        while (list.children.length > 400) list.firstChild.remove();
        list.scrollTop = list.scrollHeight;
      },
      complete() {
        q('fill').style.width = '100%';
      },
      result(text, { actions = [] } = {}) {
        const box = q('result');
        box.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }));
        if (actions.length) {
          const row = Object.assign(document.createElement('div'), { className: 'actions' });
          for (const { label, onClick, href } of actions) {
            const el = href
              ? Object.assign(document.createElement('a'), { className: 'btn', href, target: '_blank', rel: 'noopener noreferrer', textContent: label })
              : Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: label });
            if (onClick) el.addEventListener('click', onClick);
            row.appendChild(el);
          }
          box.appendChild(row);
        }
        box.hidden = false;
      },
    };
  }

  const importView = createRunView($('run'));

  function eta(task, done, total) {
    if (done < 8 || done >= total) return '';
    const active = Date.now() - task.startedAt - task.waited;
    const remaining = ((total - done) * active) / done / 1000;
    if (remaining < 60) return ' · under a minute left';
    return ` · about ${n(Math.round(remaining / 60))} min left`;
  }

  const arenaUrl = (owner, slug) => `https://www.are.na/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`;

  async function startRun(dryRun) {
    const plan = state.plan;
    if (!plan || busy()) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const run = (state.run = { controller, dryRun, startedAt: Date.now(), waited: 0, plan });

    importView.reset(dryRun ? 'Simulating…' : 'Preparing…');
    $('channels').replaceChildren();
    $('channels-head').hidden = true;
    render();
    const release = await holdPage();

    const journal = dryRun ? emptyJournal() : state.journal;
    const client = dryRun ? new DryRunClient({ signal }) : new ArenaClient(session.token, { signal, onWait: (until) => (run.waited += importView.wait(until)) });
    const persist = dryRun ? () => {} : throttle(saveJournal, 800);

    try {
      const result = await runImport({
        plan,
        client,
        journal,
        me: dryRun ? null : state.me,
        imageMode: $('image-mode').value,
        signal,
        persist,
        emit: (event) => onImportEvent(run, event),
      });
      if (!dryRun) state.lastOutcome = result.failures.length ? 'failed' : 'done';
      showImportResult(run, result);
    } catch (err) {
      if (err instanceof AbortedError || err.name === 'AbortError') {
        importView.phase(dryRun ? 'Simulation stopped' : 'Paused');
        if (!dryRun) {
          state.lastOutcome = 'paused';
          importView.result('Paused. Resume whenever you like: what is already on Are.na won’t be made again.');
        }
      } else {
        state.lastOutcome = 'paused';
        importView.phase('Transfer stopped');
        importView.result(fatalMessage(err));
        importView.log('error', err.message);
      }
    } finally {
      if (!dryRun) persist.flush();
      importView.stopWaiting();
      release();
      state.run = null;
      render();
    }
  }

  function onImportEvent(run, event) {
    switch (event.type) {
      case 'phase':
        importView.phase(run.dryRun ? `Simulation · ${event.label}` : event.label);
        importView.log('info', event.label);
        break;
      case 'progress': {
        const c = event.counts;
        importView.progress(event.done, event.total, run.dryRun ? '' : eta(run, event.done, event.total));
        importView.counts({ created: c.created, connected: c.connected + c.linked, skipped: c.skipped, failed: c.failed });
        break;
      }
      case 'channel':
        addChannel(run, event.key, event.channel);
        break;
      case 'log':
        importView.log(event.level, event.message, event.url);
        break;
    }
  }

  function addChannel(run, key, channel) {
    const planned = run.plan.channels.find((c) => c.key === key);
    const li = document.createElement('li');
    const owner = channel.owner || state.me?.slug;
    const title = channel.title || planned?.title;
    if (!run.dryRun && owner && channel.slug) {
      li.appendChild(Object.assign(document.createElement('a'), { href: arenaUrl(owner, channel.slug), target: '_blank', rel: 'noopener noreferrer', textContent: title }));
    } else {
      li.append(title);
    }
    li.appendChild(Object.assign(document.createElement('span'), { textContent: plural(planned?.count || 0, ...words().item) }));
    $('channels').appendChild(li);
    $('channels-head').hidden = false;
  }

  function showImportResult(run, { counts, failures }) {
    importView.complete();
    const linked = counts.linked ? `, ${plural(counts.linked, 'connection', 'connections')} to Are.na originals` : '';
    if (run.dryRun) {
      importView.phase('Simulation finished');
      importView.result(
        `Simulation: ${plural(counts.channelsCreated, 'channel', 'channels')}, ${plural(counts.created, 'block', 'blocks')} and ${plural(
          counts.connected,
          'extra connection',
          'extra connections'
        )}${linked}. Nothing was changed on Are.na.`
      );
      return;
    }
    importView.phase('Transfer finished');
    const parts = [`${plural(counts.created, 'block', 'blocks')} created`];
    if (counts.connected) parts.push(plural(counts.connected, 'extra connection', 'extra connections'));
    if (counts.linked) parts.push(`${plural(counts.linked, 'connection', 'connections')} to Are.na originals`);
    if (counts.skipped) parts.push(`${plural(counts.skipped, 'item', 'items')} already there`);
    let text = `Done: ${parts.join(', ')}.`;
    if (failures.length) text += ` ${plural(failures.length, 'item', 'items')} couldn’t be transferred: “Retry failed items” tries them again.`;
    importView.result(text, {
      actions: [
        ...(state.me?.slug ? [{ label: 'Open Are.na', href: `https://www.are.na/${encodeURIComponent(state.me.slug)}` }] : []),
        { label: 'Download report', onClick: () => downloadImportReport({ counts, failures }) },
      ],
    });
  }

  function fatalMessage(err) {
    if (err.status === 401) return 'Are.na refused the token (401). Connect again with a valid token, then resume.';
    if (err.status === 403)
      return `Are.na refused to write (403). Check that the token has write access, and that your account isn’t at the free plan’s limit. ${err.message}`;
    if (err.status === 404) return `A channel disappeared during the run. Resume: it will be made again. ${err.message}`;
    if (err.status === 0) return `${err.message}. Check your connection, then resume.`;
    return `Unexpected error: ${err.message}. You can resume.`;
  }

  function downloadImportReport({ counts, failures }) {
    const channels = state.plan.channels.map((c) => {
      const ch = state.journal.channels[c.key];
      return { source: c.title, arena: ch ? arenaUrl(ch.owner || state.me.slug, ch.slug) : null };
    });
    downloadJson(`to-arena-report-${today()}.json`, { date: new Date().toISOString(), source: state.source, arenaUser: state.me?.slug, counts, channels, failures });
  }

  /* ───────────── Helpers ───────────── */

  const today = () => new Date().toISOString().slice(0, 10);

  function downloadJson(filename, value) {
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })),
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function throttle(fn, ms) {
    let timer = null;
    const throttled = () => {
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          fn();
        }, ms);
      }
    };
    throttled.flush = () => {
      clearTimeout(timer);
      timer = null;
      fn();
    };
    return throttled;
  }

  function warnBeforeLeaving(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  /* During a run: warn before closing the tab, and keep the screen awake. */
  async function holdPage() {
    window.addEventListener('beforeunload', warnBeforeLeaving);
    let lock = null;
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      lock = null;
    }
    return () => {
      window.removeEventListener('beforeunload', warnBeforeLeaving);
      lock?.release().catch(() => {});
    };
  }

  /* ───────────── Start ───────────── */

  const savedToken =
    store.get('localStorage', TOKEN_KEY) ||
    store.get('sessionStorage', TOKEN_KEY) ||
    store.get('localStorage', LEGACY_TOKEN_KEY) ||
    store.get('sessionStorage', LEGACY_TOKEN_KEY);
  if (savedToken) {
    $('token').value = savedToken;
    $('remember').checked = !!(store.get('localStorage', TOKEN_KEY) || store.get('localStorage', LEGACY_TOKEN_KEY));
    connect();
  }

  render();
  $('boot-warning').remove();
  window.toArena = { loadExport, state, go };
})();
