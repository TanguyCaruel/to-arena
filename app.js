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

  /* Set by demo/demo.js: simulated sites and Are.na, so the whole flow can be tried without accounts. */
  const demo = window.TO_ARENA_DEMO || null;

  /*
   * Are.na OAuth application of the online version (a public client: PKCE, no secret). Its redirect
   * address is oauth.html next to this page. Empty: “Connect with Are.na” stays hidden and a
   * personal access token is used instead.
   */
  const OAUTH_CLIENT_ID = '';
  const OAUTH_AUTHORIZE = 'https://www.are.na/oauth/authorize';
  const OAUTH_TOKEN = 'https://api.are.na/v3/oauth/token';
  const oauthAvailable = () => !!demo || (!!OAUTH_CLIENT_ID && location.protocol === 'https:');

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const nf = new Intl.NumberFormat('en-US');
  const n = (x) => nf.format(x);
  const plural = (count, one, many) => `${n(count)} ${count === 1 ? one : many}`;

  const TOKEN_KEY = 'to-arena:token';
  const LEGACY_TOKEN_KEY = 'cosmos-to-arena:token';
  /* Same key as the first versions, so their history keeps preventing duplicates. */
  const journalKey = (userId) => `cosmos-to-arena:journal:${userId}`;

  const SITES = {
    cosmos: { url: 'https://www.cosmos.so/', collection: ['collection', 'collections'], sub: ['sub-collection', 'sub-collections'], item: ['item', 'items'], nest: 'Put sub-collections inside their parent channel' },
    pinterest: { url: 'https://www.pinterest.com/', collection: ['board', 'boards'], sub: ['section', 'sections'], item: ['pin', 'pins'], nest: 'Put each section inside its board’s channel' },
  };
  const site = () => SITES[state.source] || SITES.cosmos;
  /* “2 boards and 1 section”: sub-collections are named apart from the collections that hold them. */
  function describe(collections) {
    const s = site();
    const subs = collections.filter((c) => c.parentId && state.data?.collections.some((p) => p.id === c.parentId)).length;
    const tops = collections.length - subs;
    return [tops ? plural(tops, ...s.collection) : '', subs ? plural(subs, ...s.sub) : ''].filter(Boolean).join(' and ');
  }
  /* Where an export may come from when it is sent straight to this page. */
  const SOURCE_ORIGIN = /^https:\/\/((www\.)?cosmos\.so|([a-z]{2,3}\.)?pinterest\.(com|[a-z]{2})(\.[a-z]{2})?)$/;

  /* Which keys open the console, for the instructions. */
  const ua = navigator.userAgent;
  const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'your browser';
  const consoleKeys = browser === 'Firefox' ? (isMac ? '⌥⌘K' : 'Ctrl+Shift+K') : browser === 'Safari' ? '⌥⌘C' : isMac ? '⌥⌘J' : 'Ctrl+Shift+J';
  const barKeys = isMac ? '⇧⌘B' : 'Ctrl+Shift+B';

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
    method: null,
    waiting: false,
    showHowto: false,
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
    { id: 'pick', label: 'Pick', desc: 'Choose boards or collections on the site; they come back here.' },
    { id: 'connect', label: 'Connect', desc: 'Link your Are.na account and pick a few settings.' },
    { id: 'transfer', label: 'Transfer', desc: 'Review, simulate if you like, then create the channels.' },
  ];

  function reachable(id) {
    switch (id) {
      case 'source':
        return true;
      case 'pick':
        return !!state.source;
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
    const index = FLOW.findIndex((s) => s.id === state.step);

    const crumb = $('crumb');
    crumb.replaceChildren();
    if (state.source) {
      const home = el('button', { type: 'button', textContent: 'To Are.na' });
      home.addEventListener('click', goHome);
      crumb.append(home, el('span', { className: 'crumb__sep', textContent: '/' }), el('span', { className: 'crumb__current', textContent: SOURCES[state.source].label }));
    } else {
      crumb.append(el('span', { className: 'crumb__current', textContent: 'To Are.na' }));
    }

    const steps = $('steps');
    steps.replaceChildren();
    for (const step of FLOW) {
      const li = document.createElement('li');
      if (step.id === state.step) {
        li.setAttribute('aria-current', 'step');
        li.append(step.label, el('span', { className: 'steps__desc', textContent: step.desc }));
      } else if (reachable(step.id)) {
        li.className = 'is-reachable';
        const button = el('button', { type: 'button', textContent: step.label });
        button.addEventListener('click', () => go(step.id));
        li.appendChild(button);
      } else {
        li.textContent = step.label;
      }
      steps.appendChild(li);
    }
    const count = $('step-count');
    count.replaceChildren(`Step ${index + 1} of ${FLOW.length} · ${FLOW[index]?.label || ''}`);
    const previous = FLOW[index - 1];
    if (previous && reachable(previous.id)) {
      const back = el('button', { type: 'button', className: 'link', textContent: `Back to ${previous.label}` });
      back.addEventListener('click', () => go(previous.id));
      count.append(' · ', back);
    }

    for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.dataset.step !== state.step;
    for (const node of document.querySelectorAll('[data-only]')) node.hidden = node.dataset.only !== state.source;
    for (const node of document.querySelectorAll('.source-name')) node.textContent = state.source ? SOURCES[state.source].label : '';
    for (const choice of document.querySelectorAll('.choice')) choice.setAttribute('aria-pressed', String(choice.dataset.source === state.source));
    $('nest-label').textContent = site().nest;

    if (!state.run) state.plan = state.data ? buildPlan(state.data, options()) : null;
    updatePick();
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
      if (state.source !== source) {
        state.data = null;
        state.selected = new Set();
        state.waiting = false;
        state.method = source === 'pinterest' && browser !== 'Firefox' ? 'console' : 'bookmark';
        resetDrop();
      }
      state.source = source;
      go('pick');
    });
  }

  for (const button of document.querySelectorAll('[data-next]')) {
    button.addEventListener('click', () => go(button.dataset.next));
  }

  /* ───────────── Pick: the export script and the site ───────────── */

  /*
   * Each script carries the shared kit and this page's address, so it runs on its own in the
   * bookmark or the console, and sends its result back here only.
   */
  const EXPORTERS = { cosmos: window.cosmosExport, pinterest: window.pinterestExport };
  const scriptFor = (source) =>
    `(function () {\n${window.exportKit.toString()}\n(${EXPORTERS[source].toString()})(${JSON.stringify({ toolOrigin: location.origin })});\n})();`;

  function openSite() {
    state.waiting = true;
    if (demo) demo.openSource(state.source, { receive });
    else window.open(site().url, 'to-arena-source');
    updatePick();
  }

  async function copyScript(button) {
    const text = scriptFor(state.source);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = el('textarea', { value: text });
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy the script'), 2500);
  }

  const kbd = (text) => el('kbd', { textContent: text });
  const btn = (label, onClick, className = 'btn btn--sm') => {
    const button = el('button', { type: 'button', className, textContent: label });
    button.addEventListener('click', () => onClick(button));
    return button;
  };

  function bookmarkletLink() {
    const link = el('a', { className: 'btn btn--sm bookmarklet', href: `javascript:${encodeURIComponent(scriptFor(state.source))}`, textContent: 'Send to Are.na' });
    link.title = 'Drag me to your bookmarks bar';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      link.textContent = 'Drag me to the bookmarks bar';
      setTimeout(() => (link.textContent = 'Send to Are.na'), 2500);
    });
    return link;
  }

  /* The steps on screen, for this source, this browser and this way of running the script. */
  function renderHowto() {
    const list = $('howto');
    list.replaceChildren();
    const s = site();
    const name = SOURCES[state.source].label;
    const where =
      state.source === 'pinterest'
        ? 'Go to the board you want, or to your profile to pick several.'
        : 'Go to the collection you want, or anywhere else to pick several.';
    const step = (...children) => {
      const li = document.createElement('li');
      li.append(...children);
      list.appendChild(li);
      return li;
    };
    const action = (...children) => {
      const span = el('span', { className: 'inline-action' });
      span.append(...children);
      return span;
    };
    const open = btn(`Open ${name}`, openSite, 'btn btn--sm');
    open.append(arrowIcon());

    if (state.method === 'console') {
      step('Copy the script.', action(btn('Copy the script', copyScript)));
      step(`Open ${name}, signed in. ${where}`, action(open));
      const keys = step('Open the console with ', kbd(consoleKeys), ', paste the script and press Enter.');
      if (browser === 'Chrome' || browser === 'Edge') keys.append(' The first time, Chrome asks you to type ', el('code', { textContent: 'allow pasting' }), ' before.');
      if (browser === 'Safari') keys.append(' In Safari, first turn on Settings › Advanced › Show features for web developers.');
      step(`Tick the ${s.collection[1]} you want in the panel that appears, then send. They come back here by themselves.`);
      $('howto-trust').textContent = `Only paste code you trust into a console. This script comes from this page: it reads your ${s.collection[1]}, writes nothing on ${name}, and sends them to this tab only.`;
    } else {
      const drag = step('Drag this button to your bookmarks bar, once.', action(bookmarkletLink()));
      drag.append(el('span', { className: 'hint block', textContent: `Bookmarks bar hidden? Show it with ${barKeys}.` }));
      step(`Open ${name}, signed in. ${where}`, action(open));
      step(`Click the “Send to Are.na” bookmark, tick what you want, then send. It comes back here by itself.`);
      $('howto-trust').textContent = `The bookmark only reads your ${s.collection[1]}, with the session already open in your browser, and sends them to this tab only.`;
    }

    const toggle = $('method-switch');
    toggle.textContent = state.method === 'console' ? 'Use a bookmark instead' : 'No bookmarks bar? Use the console instead';
    if (state.source === 'pinterest' && state.method === 'console') toggle.textContent = 'Using Firefox? Use a bookmark instead';
  }

  $('method-switch').addEventListener('click', () => {
    state.method = state.method === 'console' ? 'bookmark' : 'console';
    renderHowto();
  });

  function arrowIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 12h15M13 6l6 6-6 6');
    svg.appendChild(path);
    return svg;
  }

  let howtoFor = '';

  function updatePick() {
    if (state.step !== 'pick' || !state.source) return;
    const key = `${state.source}:${state.method}`;
    if (howtoFor !== key) {
      renderHowto();
      howtoFor = key;
    }
    const received = !!state.data && !state.showHowto;
    $('pick-howto').hidden = received;
    $('pick-received').hidden = !received;
    const waiting = $('pick-waiting');
    waiting.hidden = !state.waiting || received;
    waiting.textContent = `Waiting for your ${site().collection[1]}… Leave this tab open while you pick on ${SOURCES[state.source].label}.`;
    if (!state.data) return;
    const count = state.selected.size + ($('include-library').checked ? 1 : 0);
    const stats = state.plan?.stats;
    $('choose-count').textContent = count
      ? `${describe(state.data.collections.filter((c) => state.selected.has(c.id)))} · about ${plural(stats?.connections || 0, 'block', 'blocks')}`
      : 'Nothing selected';
    document.querySelector('[data-next="connect"]').disabled = !count;
  }

  /* An export sent by the script from the site's tab: answer its handshake, then take the data. */
  window.addEventListener('message', (e) => {
    if (!SOURCE_ORIGIN.test(e.origin) || typeof e.data !== 'object' || !e.data) return;
    if (e.data.type === 'to-arena/hello') {
      e.source?.postMessage({ type: 'to-arena/ready' }, e.origin);
    } else if (e.data.type === 'to-arena/export') {
      try {
        receive(e.data.data, e.data.filename);
        window.focus();
      } catch (err) {
        showLoadError(err);
      }
    }
  });

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
    $('load-error').hidden = true;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('This file is too large to be an export.');
      receive(JSON.parse(await file.text()), file.name);
    } catch (err) {
      showLoadError(err);
    }
  }

  function showLoadError(err) {
    $('load-error').textContent = err instanceof SyntaxError ? 'This file isn’t valid JSON.' : err.message;
    $('load-error').hidden = false;
  }

  /* Takes an export, from the site's tab, a file or the demo. */
  function receive(raw, filename = 'export.json') {
    const data = normalizeExport(raw);
    state.data = data;
    state.filename = filename;
    state.source = data.source;
    state.method = state.method || (data.source === 'pinterest' && browser !== 'Firefox' ? 'console' : 'bookmark');
    state.waiting = false;
    state.showHowto = false;
    state.selected = new Set(data.collections.filter((c) => !c.system).map((c) => c.id));
    $('drop-title').textContent = `✓ ${filename}`;
    $('include-library').checked = !!data.library;
    $('load-error').hidden = true;
    renderCollections();
    document.title = `✓ Received · To Are.na`;
    setTimeout(() => (document.title = 'To Are.na'), 4000);
    go('pick');
  }

  function resetDrop() {
    $('drop-title').textContent = 'Add your export file';
    $('file').value = '';
  }

  $('pick-again').addEventListener('click', () => {
    state.showHowto = true;
    updatePick();
  });

  /* ───────────── Received collections ───────────── */

  function renderCollections() {
    const { collections, user, elements, library } = state.data;
    const s = site();
    const names = collections.filter((c) => !c.parentId);
    $('received-title').textContent = `Received ${describe(collections)}${names.length === 1 ? `: ${names[0].name}` : ''}.`;
    $('export-summary').textContent = `From @${user?.username || '?'} · ${plural(Object.keys(elements).length, ...s.item)}. Untick what you don’t want.`;

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
    $('collections-toolbar').hidden = collections.length < 7;

    $('library-row').hidden = !library;
    if (library) $('library-meta').textContent = `${plural(library.elementIds.length, ...s.item)}, including those in no collection. Makes one more channel.`;
  }

  function collectionRow(c, isChild, user) {
    const li = document.createElement('li');
    li.dataset.name = normalize(c.name);
    const label = el('label', { className: `row${isChild ? ' row--child' : ''}` });
    const box = el('input', { type: 'checkbox', checked: state.selected.has(c.id) });
    box.dataset.id = c.id;
    const thumb = el('img', { className: 'thumb', alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    const src = thumbUrl(c.cover);
    if (src) thumb.src = src;
    const text = el('span', { className: 'row__text' });
    const meta = [plural(c.elementIds.length, ...site().item)];
    if (c.isPrivate) meta.push(state.source === 'pinterest' ? 'secret' : 'private');
    if (c.system) meta.push('public profile');
    if (c.owner && user?.username && c.owner !== user.username) meta.push(`with @${c.owner}`);
    text.append(el('span', { className: 'row__name', textContent: c.name || 'Untitled' }), el('span', { className: 'row__meta', textContent: meta.join(' · ') }));
    label.append(box, thumb, text);
    li.appendChild(label);
    return li;
  }

  /* Only the sources' own image hosts: a doctored export file can't make the page call anywhere else. */
  function thumbUrl(url) {
    if (demo) return demo.image(url);
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

  /* ───────────── Connect ───────────── */

  const makeClient = (token, opts = {}) => (demo ? demo.makeClient(token, opts) : new ArenaClient(token, opts));

  $('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const token = $('token').value.trim();
    if (token) connect(token, $('connect'));
  });

  $('oauth-connect').addEventListener('click', async () => {
    const button = $('oauth-connect');
    if (busy()) return;
    $('token-error').hidden = true;
    try {
      const token = demo ? await demo.authorize() : await authorize();
      if (token) await connect(token, button);
    } catch (err) {
      showTokenError(err);
    }
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

  function forgetToken() {
    for (const area of ['localStorage', 'sessionStorage']) {
      store.remove(area, TOKEN_KEY);
      store.remove(area, LEGACY_TOKEN_KEY);
    }
  }

  /* Checks the token, then that it can write: a read-only token would fail at the first channel. */
  async function connect(token, button) {
    if (busy()) return;
    const label = button.firstChild?.nodeType === Node.TEXT_NODE ? button.firstChild : null;
    const before = label?.textContent;
    button.disabled = true;
    if (label) label.textContent = 'Checking… ';
    $('token-error').hidden = true;
    try {
      const client = makeClient(token);
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
      if (label) label.textContent = before;
      render();
    }
  }

  function showTokenError(err) {
    const box = $('token-error');
    if (err.readOnly) {
      const link = el('a', {
        href: 'https://www.are.na/settings/personal-access-tokens',
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: 'Create a token with read and write access →',
      });
      box.replaceChildren('This token can only read, so it can’t create channels. ', link, ', then paste it here.');
      $('token').value = '';
      if ($('token').offsetParent) $('token').focus();
    } else if (err.cancelled) {
      return;
    } else {
      box.textContent = err.status === 401 ? 'Are.na refused this token. Check that it is complete, or create a new one.' : `Can’t connect: ${err.message}`;
    }
    box.hidden = false;
  }

  /* ── “Connect with Are.na”: OAuth in a popup, with PKCE ── */

  const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (length) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => chars[b % chars.length]).join('');
  };

  async function authorize() {
    const verifier = randomString(64);
    const expectedState = randomString(24);
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const redirect = new URL('oauth.html', location.href).href;
    const url = new URL(OAUTH_AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'write',
      state: expectedState,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const popup = window.open(url.href, 'to-arena-oauth', 'width=560,height=760');
    if (!popup) throw new Error('Your browser blocked the Are.na window. Allow pop-ups for this page, then try again.');

    const code = await new Promise((resolve, reject) => {
      const stop = () => {
        clearInterval(watch);
        window.removeEventListener('message', onMessage);
      };
      const onMessage = (e) => {
        if (e.origin !== location.origin || e.source !== popup || e.data?.type !== 'to-arena/oauth') return;
        stop();
        if (e.data.state !== expectedState) reject(new Error('The Are.na answer didn’t match this request. Try again.'));
        else if (e.data.error || !e.data.code) reject(new Error(e.data.error === 'access_denied' ? 'Access was not allowed on Are.na.' : `Are.na said: ${e.data.error || 'no code'}`));
        else resolve(e.data.code);
      };
      const watch = setInterval(() => {
        if (popup.closed) {
          stop();
          reject(Object.assign(new Error('Closed'), { cancelled: true }));
        }
      }, 600);
      window.addEventListener('message', onMessage);
    });

    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: OAUTH_CLIENT_ID, code, redirect_uri: redirect, code_verifier: verifier }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.access_token) throw new Error(`Are.na didn’t hand over access (${res.status}).`);
    return json.access_token;
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

  const saveJournal = () => !demo && state.me && store.set('localStorage', journalKey(state.me.id), JSON.stringify(state.journal));

  $('forget-journal').addEventListener('click', () => {
    if (!state.me || busy()) return;
    const ok = window.confirm('Forget the import history of this account? Channels already made stay on Are.na; the next transfer finds them again through their metadata.');
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
      .map((part) => part.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

  /* With OAuth, the token form moves into “Use a personal access token instead”. */
  if (oauthAvailable()) {
    $('oauth-block').hidden = false;
    $('token-alt').hidden = false;
    $('token-alt').appendChild($('token-block'));
  }

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
      text.replaceChildren('Signed in as ', el('strong', { textContent: name }), ` · ${tier}`);
      if (already) text.append(` · ${plural(already, 'block', 'blocks')} imported from this browser`);
    }
    const stats = state.plan?.stats;
    $('connect-estimate').textContent =
      stats && me?.tier === 'free'
        ? `About ${plural(stats.connections + stats.nests, 'block', 'blocks')} of the ${FREE_TIER_LIMIT} a free account holds`
        : '';
    $('connect-next').disabled = !(me && stats?.channels);
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
    const row = (label, value) => table.append(el('dt', { textContent: label }), el('dd', { textContent: value }));
    row('Channels', n(stats.channels) + (stats.nests ? ` (${n(stats.nests)} inside another)` : ''));
    row('New blocks', n(stats.blocks));
    if (stats.reused) row('Extra connections, for items in several channels', n(stats.reused));
    if (stats.arena) row('Connections to Are.na originals', n(stats.arena));
    if (stats.skippedElements) row('Items without content, skipped', n(stats.skippedElements));
    row('Estimated time', demo ? 'a few seconds in the demo' : `about ${n(minutes)} min, plus any pause Are.na asks for`);

    const warning = $('plan-warning');
    const total = stats.connections + stats.nests;
    warning.hidden = me?.tier !== 'free';
    if (me?.tier === 'free') {
      warning.replaceChildren(
        'A free Are.na account holds ',
        el('strong', { textContent: `${FREE_TIER_LIMIT} blocks` }),
        ` in total. This transfer adds ${n(total)}`,
        total > FREE_TIER_LIMIT ? ', so it would stop partway: upgrade to Premium, or select less.' : ', on top of what you already have.'
      );
    }

    simulate.disabled = busy();
    start.disabled = !me || busy() || !stats.channels;
    start.textContent = state.lastOutcome === 'paused' ? 'Resume' : state.lastOutcome === 'failed' ? 'Retry failed items' : 'Transfer';
  }

  $('start').addEventListener('click', () => {
    if (state.run) state.run.controller.abort();
    else startRun(false);
  });
  $('simulate').addEventListener('click', () => startRun(true));

  /* ───────────── Progress ───────────── */

  function createRunView(root) {
    const q = (key) => root.querySelector(`[data-run="${key}"]`);
    let waitTimer = null;
    return {
      reset(phase) {
        root.hidden = false;
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
        const li = el('li', { className: level });
        li.textContent = `${new Date().toLocaleTimeString('en-GB')}  ${message}`;
        const safe = normalizeUrl(url);
        if (safe) {
          li.append(' · ');
          li.appendChild(el('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', textContent: 'source' }));
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
        box.replaceChildren(el('p', { textContent: text }));
        if (actions.length) {
          const row = el('div', { className: 'actions' });
          for (const { label, onClick, href } of actions) {
            const node = href
              ? el('a', { className: 'btn', href, target: '_blank', rel: 'noopener noreferrer', textContent: label })
              : el('button', { type: 'button', className: 'btn', textContent: label });
            if (onClick) node.addEventListener('click', onClick);
            row.appendChild(node);
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
    const client = dryRun ? new DryRunClient({ signal }) : makeClient(session.token, { signal, onWait: (until) => (run.waited += importView.wait(until)) });
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
    if (!run.dryRun && !demo && owner && channel.slug) {
      li.appendChild(el('a', { href: arenaUrl(owner, channel.slug), target: '_blank', rel: 'noopener noreferrer', textContent: title }));
    } else {
      li.append(title);
    }
    li.appendChild(el('span', { textContent: plural(planned?.count || 0, ...site().item) }));
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
    const open = demo
      ? [{ label: 'See the result', onClick: () => demo.showResult() }]
      : state.me?.slug
        ? [{ label: 'Open Are.na', href: `https://www.are.na/${encodeURIComponent(state.me.slug)}` }]
        : [];
    importView.result(text, { actions: [...open, { label: 'Download report', onClick: () => downloadImportReport({ counts, failures }) }] });
  }

  function fatalMessage(err) {
    if (err.status === 401) return 'Are.na refused the access (401). Connect again, then resume.';
    if (err.status === 403) return `Are.na refused to write (403). Check that your access can write, and that your account isn’t at the free plan’s limit. ${err.message}`;
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
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), download: filename });
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

  $('desktop-note').hidden = !(matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches);
  if (location.protocol === 'file:' || demo) $('demo-link').hidden = true;

  const savedToken = !demo &&
    (store.get('localStorage', TOKEN_KEY) || store.get('sessionStorage', TOKEN_KEY) || store.get('localStorage', LEGACY_TOKEN_KEY) || store.get('sessionStorage', LEGACY_TOKEN_KEY));
  if (savedToken) {
    $('remember').checked = !!(store.get('localStorage', TOKEN_KEY) || store.get('localStorage', LEGACY_TOKEN_KEY));
    connect(savedToken, $('connect'));
  }

  render();
  $('boot-warning').remove();
  window.toArena = { receive, state, go };
})();
