/*
 * To Are.na · import engine (no interface)
 *
 * - normalizeExport : checks an export file (Cosmos or Pinterest) and brings it to the current shape
 * - ArenaClient     : Are.na API v3 calls that respect its rate limits
 * - buildPlan       : turns an export into channels and blocks to create
 * - runImport       : runs the plan and resumes where it stopped (journal)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ToArena = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://api.are.na/v3';
  const S3_TEMP = 'https://s3.amazonaws.com/arena_images-temp/';
  const FREE_TIER_LIMIT = 200;

  /*
   * Each source tags what it creates on Are.na with its own metadata keys, so a later run can
   * find its channels and blocks again. Cosmos keeps the keys of the first version of the tool.
   */
  const SOURCES = {
    cosmos: {
      label: 'Cosmos',
      prefix: '',
      library: '__library__',
      meta: { collection: 'cosmos_cluster_id', slug: 'cosmos_slug', item: 'cosmos_element_id', index: 'cosmos_media_index', url: 'cosmos_url' },
    },
    pinterest: {
      label: 'Pinterest',
      prefix: 'pinterest:',
      library: '__library__',
      meta: { collection: 'pinterest_board_id', slug: 'pinterest_slug', item: 'pinterest_pin_id', index: 'pinterest_media_index', url: 'pinterest_url' },
    },
  };

  /* Hosts the tool may download media from when it uploads files itself. */
  const MEDIA_HOSTS = /^(cdn\.cosmos\.so|i\.pinimg\.com|v\d*\.pinimg\.com)$/;

  /* The source whose `field` key is present in an Are.na metadata object. */
  function metaSource(metadata, field) {
    if (!metadata) return null;
    for (const [name, source] of Object.entries(SOURCES)) {
      if (metadata[source.meta[field]] != null) return { name, ...source };
    }
    return null;
  }

  class AbortedError extends Error {
    constructor() {
      super('Paused');
      this.name = 'AbortError';
    }
  }

  class ArenaError extends Error {
    constructor(status, message, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AbortedError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortedError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /* ───────────────────────── Export files ───────────────────────── */

  /* Accepts the current format and the first Cosmos format (`cosmos-export/1`). */
  function normalizeExport(data) {
    const legacy = data?.schema === 'cosmos-export/1';
    if (!legacy && data?.schema !== 'arena-import/1') {
      throw new Error('This file was not made by the export script of this tool.');
    }
    const source = legacy ? 'cosmos' : data.source;
    if (!SOURCES[source]) throw new Error(`Unknown source “${source}”.`);
    if (!Array.isArray(data.collections) || !data.elements || typeof data.elements !== 'object') {
      throw new Error('This export file is incomplete.');
    }
    const elements = Object.create(null);
    for (const [id, el] of Object.entries(data.elements)) {
      if (el && typeof el === 'object') elements[id] = { ...el, url: el.url ?? el.cosmosUrl ?? null };
    }
    const collections = data.collections
      .filter((c) => c && c.id != null)
      .map((c) => ({ ...c, id: String(c.id), parentId: c.parentId != null ? String(c.parentId) : null, elementIds: (c.elementIds || []).map(String) }));
    return { ...data, schema: 'arena-import/1', source, collections, elements };
  }

  /* ───────────────────────── API client ───────────────────────── */

  class ArenaClient {
    constructor(token, { fetchImpl, signal, onWait, writeGap = 600 } = {}) {
      this.token = token;
      this.fetch = fetchImpl || ((...args) => fetch(...args));
      this.signal = signal;
      this.onWait = onWait || (() => {});
      this.writeGap = writeGap;
      this.lastWrite = 0;
      this.blockedUntil = { read: 0, write: 0 };
    }

    async request(method, path, { body, query } = {}) {
      const kind = method === 'GET' ? 'read' : 'write';
      const url = new URL(API + path);
      for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
      let failures = 0;
      for (;;) {
        await this.waitForBudget(kind);
        if (kind === 'write') {
          const gap = this.lastWrite + this.writeGap - Date.now();
          if (gap > 0) await sleep(gap, this.signal);
          this.lastWrite = Date.now();
        }
        let res;
        try {
          res = await this.fetch(url.toString(), {
            method,
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: 'application/json',
              ...(body && { 'Content-Type': 'application/json' }),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: this.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          });
        } catch (err) {
          if (this.signal?.aborted) throw new AbortedError();
          if (++failures > 4) throw new ArenaError(0, `Can’t reach Are.na (${err.message})`);
          await sleep(1000 * 2 ** failures, this.signal);
          continue;
        }
        if (res.status === 429) {
          this.blockedUntil[kind] = resetTime(res);
          continue;
        }
        if (res.status >= 500 && ++failures <= 4) {
          await sleep(1000 * 2 ** failures, this.signal);
          continue;
        }
        if (res.headers.has('x-ratelimit-remaining') && Number(res.headers.get('x-ratelimit-remaining')) <= 0) {
          this.blockedUntil[kind] = resetTime(res);
        }
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (!res.ok) throw new ArenaError(res.status, errorMessage(res.status, data), data);
        return data;
      }
    }

    async waitForBudget(kind) {
      const until = this.blockedUntil[kind];
      if (until > Date.now()) {
        this.onWait(until, kind);
        await sleep(until - Date.now(), this.signal);
        this.onWait(0, kind);
      }
    }
  }

  function resetTime(res) {
    const retry = Number(res.headers.get('retry-after'));
    if (retry > 0) return Date.now() + retry * 1000 + 500;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (reset > 0) return Math.max(Date.now() + 1000, reset * 1000 + 500);
    return Date.now() + 60_000;
  }

  function errorMessage(status, data) {
    const detail = data?.details?.message || data?.message || data?.error;
    return detail ? `${String(detail).slice(0, 300)} (${status})` : `Are.na error ${status}`;
  }

  /* Stands in for the API in simulation mode: nothing is written. */
  class DryRunClient {
    constructor({ signal } = {}) {
      this.signal = signal;
      this.nextId = 1;
    }
    async request(method, path, { body } = {}) {
      await sleep(8, this.signal);
      if (method === 'GET' && path.endsWith('/contents')) return { data: [], meta: { has_more_pages: false } };
      const id = this.nextId++;
      if (method === 'GET') return { id, state: 'available' };
      if (path === '/channels') return { id, slug: `simulation-${id}`, title: body.title };
      if (path === '/uploads/presign') return { files: [{ upload_url: 'about:blank', key: `sim-${id}` }] };
      return { id };
    }
  }

  /* ───────────────────────── Plan ───────────────────────── */

  /* An http(s) URL, with `https://` added to a bare domain; null for anything else (javascript:, data:…). */
  function normalizeUrl(input) {
    if (!input) return null;
    let s = String(input).trim();
    if (!/^https?:\/\//i.test(s)) {
      if (!/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return null;
      s = `https://${s}`;
    }
    try {
      const url = new URL(s);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  /* Media and covers must be https: anything else in an export file is ignored. */
  function safeMediaUrl(input) {
    try {
      const url = new URL(String(input));
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  const join = (parts, sep = '\n\n') => parts.filter(Boolean).join(sep);

  function clean(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v != null && v !== '' && v !== false) out[k] = v;
    return out;
  }

  /* First sentence of a caption; “A.V. Mazzega” or “J. Smith” don't end the sentence. */
  function shortTitle(caption) {
    if (!caption) return '';
    let first = caption.split(/(?<=[\p{Ll}\d)\]"'»][.!?])\s+(?=[\p{Lu}\d«"'])/u)[0].replace(/[.]$/, '').trim();
    if (first.length > 120) first = `${first.slice(0, 117).replace(/\s+\S*$/, '')}…`;
    return first;
  }

  const same = (a, b) => !!a && !!b && a.toLowerCase().replace(/[.…\s]+$/, '') === b.toLowerCase().replace(/[.…\s]+$/, '');

  const escapeMd = (s) => String(s).replace(/([[\]])/g, '\\$1');

  /* First path segments of are.na URLs that are not a channel (/{user}/{channel}). */
  const ARENA_RESERVED = new Set(
    'about,api,blog,block,community,developers,editorial,education,explore,faq,feed,group,groups,log_in,login,notifications,oauth,pricing,privacy,roadmap,search,settings,share,sign_up,signup,support,terms,tools,tos'.split(',')
  );

  /*
   * Recognises content that already lives on Are.na:
   *   are.na/block/123                     → block 123
   *   d2w9rnfcy7mm78.cloudfront.net/123/…  → image of block 123 (Are.na's CDN)
   *   are.na/user/channel                  → channel (when `channels`)
   */
  function arenaRef(input, { channels = true } = {}) {
    let url;
    try {
      url = new URL(normalizeUrl(input));
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'are.na') {
      if (parts[0] === 'block' && /^\d+$/.test(parts[1] || '')) return { type: 'Block', id: Number(parts[1]) };
      if (channels && parts.length === 2 && !ARENA_RESERVED.has(parts[0].toLowerCase())) {
        return { type: 'Channel', slug: decodeURIComponent(parts[1]) };
      }
      return null;
    }
    if (host === 'd2w9rnfcy7mm78.cloudfront.net' && /^\d+$/.test(parts[0] || '')) return { type: 'Block', id: Number(parts[0]) };
    return null;
  }

  /* A channel is only linked for a “website” item; an image is only linked to its original block. */
  const elementArenaRef = (el) => (el.kind === 'text' ? null : arenaRef(el.source?.url, { channels: el.kind === 'website' }));

  function blockPayloads(el, { captions = true, credits = true, carousel = 'first', source = 'cosmos' } = {}) {
    const { prefix, meta } = SOURCES[source] || SOURCES.cosmos;
    const src = normalizeUrl(el.source?.url);
    const author = el.source?.author;
    const authorUrl = normalizeUrl(author?.url);
    const caption = captions ? (el.caption || '').trim() : '';
    const credit = credits && author?.name ? (authorUrl ? `Via [${escapeMd(author.name)}](${authorUrl})` : `Via ${author.name}`) : '';
    const sourceFields = src ? { original_source_url: src, original_source_title: author?.name || hostOf(src) } : {};
    const metadata = (i) => clean({ [meta.item]: el.id, [meta.index]: i, [meta.url]: normalizeUrl(el.url) });
    const key = (i) => `${prefix}${el.id}:${i}`;

    if (el.kind === 'text') {
      const text = (el.text || '').trim();
      if (!text) return [];
      return [{ blockKey: key(0), kind: 'text', payload: clean({ value: text, ...sourceFields, metadata: metadata(0) }) }];
    }

    if (el.kind === 'website' && src) {
      const title = el.title || shortTitle(caption) || hostOf(src);
      const description = join([!same(el.description, title) && el.description, !same(caption, title) && !same(caption, el.description) && caption, credit]);
      return [
        {
          blockKey: key(0),
          kind: 'link',
          payload: clean({ value: src, title, description, cover_url: safeMediaUrl(el.media?.[0]?.url), metadata: metadata(0) }),
        },
      ];
    }

    const all = (el.media || []).filter((m) => safeMediaUrl(m?.url));
    const media = carousel === 'all' ? all : all.slice(0, 1);
    const title =
      el.kind === 'product'
        ? join([el.brand, el.title], ' — ')
        : el.title || shortTitle(caption) || author?.name || (src && hostOf(src)) || '';
    const description = join([
      !same(el.description, title) && el.description,
      !same(caption, title) && !same(caption, el.description) && caption,
      credit,
    ]);
    const alt = (el.alt || caption || '').slice(0, 1000);
    return media.map((m, i) => ({
      blockKey: key(i),
      kind: m.type === 'Video' ? 'video' : m.type === 'AnimatedImage' ? 'gif' : 'image',
      mediaUrl: safeMediaUrl(m.url),
      payload: clean({
        value: safeMediaUrl(m.url),
        title: media.length > 1 && title ? `${title} (${i + 1}/${media.length})` : title,
        description,
        alt_text: alt,
        ...sourceFields,
        metadata: metadata(i),
      }),
    }));
  }

  /*
   * Steps for one item: either a connection to the Are.na original (with a copy as fallback when
   * the original is missing or private), or one or more blocks to create.
   */
  function elementSteps(el, { arenaLinks = true, ...options } = {}) {
    const blocks = blockPayloads(el, options);
    const ref = arenaLinks ? elementArenaRef(el) : null;
    if (!ref) return blocks;
    const { prefix } = SOURCES[options.source] || SOURCES.cosmos;
    return [{ ...(blocks[0] || { blockKey: `${prefix}${el.id}:0` }), kind: 'arena', target: ref }];
  }

  function visibilityFor(mode, isPrivate) {
    if (mode === 'mirror') return isPrivate ? 'private' : 'public';
    return mode;
  }

  /*
   * Items are created from the oldest (bottom of the collection) to the newest: Are.na shows the
   * latest additions first, so the visual order is kept.
   * A Pinterest board also lists the pins of its sections; when a section is imported as its own
   * channel inside the board's channel, its pins are left out of the board's channel.
   */
  function buildPlan(data, options = {}) {
    const {
      selected = [],
      includeLibrary = false,
      visibility = 'mirror',
      nest = true,
      captions = true,
      credits = true,
      carousel = 'first',
      arenaLinks = true,
      libraryTitle = 'Cosmos · all items',
    } = options;
    const source = data.source || 'cosmos';
    const { prefix, meta, library } = SOURCES[source];
    const sel = new Set(selected.map(String));
    const isChild = (c) => !!(c.parentId && sel.has(c.parentId));
    const collections = data.collections.filter((c) => sel.has(c.id)).sort((a, b) => isChild(a) - isChild(b));

    const nestedChildren = new Map();
    if (nest) {
      for (const c of collections) {
        if (isChild(c)) {
          if (!nestedChildren.has(c.parentId)) nestedChildren.set(c.parentId, new Set());
          for (const id of c.elementIds) nestedChildren.get(c.parentId).add(id);
        }
      }
    }

    const channels = collections.map((c) => {
      const inChildren = c.includesChildren && nestedChildren.get(c.id);
      return {
        key: `${prefix}${c.id}`,
        title: c.name || 'Untitled',
        description: c.description || '',
        visibility: visibilityFor(visibility, c.isPrivate),
        parentKey: nest && isChild(c) ? `${prefix}${c.parentId}` : null,
        elementIds: inChildren ? c.elementIds.filter((id) => !inChildren.has(id)) : c.elementIds,
        metadata: clean({ [meta.collection]: c.id, [meta.slug]: c.slug }),
      };
    });
    if (includeLibrary && data.library) {
      channels.push({
        key: `${prefix}${library}`,
        title: libraryTitle,
        description: `Whole library imported from ${SOURCES[source].label}.`,
        visibility: visibility === 'mirror' ? 'private' : visibility,
        parentKey: null,
        elementIds: (data.library.elementIds || []).map(String),
        metadata: { [meta.collection]: library },
      });
    }

    const steps = [];
    const uniqueBlocks = new Set();
    let arena = 0;
    let skippedElements = 0;
    for (const ch of channels) {
      const list = [];
      for (const id of ch.elementIds) {
        const el = Object.hasOwn(data.elements, id) ? data.elements[id] : null;
        const items = el ? elementSteps(el, { captions, credits, carousel, arenaLinks, source }) : [];
        if (!items.length) {
          skippedElements++;
          continue;
        }
        const linkMetadata = clean({ [meta.item]: el.id, [meta.url]: normalizeUrl(el.url) });
        for (const s of items) list.push({ ...s, channelKey: ch.key, elementId: el.id, url: normalizeUrl(el.url), linkMetadata });
      }
      list.reverse();
      for (const step of list) {
        if (step.target) arena++;
        else uniqueBlocks.add(step.blockKey);
        steps.push(step);
      }
    }

    const nests = channels.filter((c) => c.parentKey).map((c) => ({ childKey: c.key, parentKey: c.parentKey }));
    return {
      source,
      channels: channels.map(({ elementIds, ...c }) => ({ ...c, count: elementIds.length })),
      steps,
      nests,
      stats: {
        channels: channels.length,
        blocks: uniqueBlocks.size,
        connections: steps.length,
        reused: steps.length - arena - uniqueBlocks.size,
        arena,
        nests: nests.length,
        skippedElements,
      },
    };
  }

  /* ───────────────────────── Running ───────────────────────── */

  function emptyJournal() {
    return { v: 1, channels: {}, blocks: {}, links: {}, nests: {} };
  }

  const pickChannel = (ch) => ({ id: ch.id, slug: ch.slug, title: ch.title, owner: ch.owner?.slug || null });

  /* Journal key of a connection: blocks and channels don't share the same id space. */
  const refLinkKey = (ref, channelId) => `${ref.type === 'Channel' ? 'channel:' : ''}${ref.id}>${channelId}`;

  /* Journal key of a block or channel found on Are.na, from its metadata. */
  function itemKey(metadata) {
    const src = metaSource(metadata, 'item');
    return src ? `${src.prefix}${metadata[src.meta.item]}:${metadata[src.meta.index] ?? 0}` : null;
  }

  function collectionKey(metadata) {
    const src = metaSource(metadata, 'collection');
    return src ? `${src.prefix}${metadata[src.meta.collection]}` : null;
  }

  /* Resolves an Are.na original (a channel is named by its slug); null when missing or private. */
  function refResolver(client) {
    const cache = new Map();
    const keyOf = (t) => (t.type === 'Block' ? `b${t.id}` : `c${t.id ?? t.slug}`);
    async function lookup(target) {
      if (target.id != null) return { type: target.type, id: target.id };
      try {
        const ch = await client.request('GET', `/channels/${encodeURIComponent(target.slug)}`);
        return ch?.id && ch.state !== 'deleted' ? { type: 'Channel', id: ch.id, title: ch.title } : null;
      } catch (err) {
        if ([403, 404].includes(err.status)) return null;
        throw err;
      }
    }
    const resolve = async (target) => {
      const key = keyOf(target);
      if (!cache.has(key)) cache.set(key, await lookup(target));
      return cache.get(key);
    };
    resolve.unavailable = (target) => cache.set(keyOf(target), null);
    return resolve;
  }

  /* Connects an existing block or channel; false when Are.na refuses it (missing, private). */
  async function connectRef(client, ref, channelId, { metadata } = {}) {
    try {
      await client.request('POST', '/connections', {
        body: {
          connectable_id: ref.id,
          connectable_type: ref.type,
          channels: [clean({ id: channelId, metadata })],
        },
      });
      return true;
    } catch (err) {
      if (err.status === 422) return true;
      if ([403, 404].includes(err.status)) return false;
      throw err;
    }
  }

  /*
   * Tells a read-only token from a read + write one without changing anything. Are.na checks the
   * token before looking the resource up, so deleting a connection that can't exist is refused
   * (403) for a read-only token and answered “not found” (404) with write access.
   */
  async function checkWriteAccess(client) {
    try {
      await client.request('DELETE', '/connections/0');
      return true;
    } catch (err) {
      if (err.status === 403) return false;
      if (err.status === 404) return true;
      throw err;
    }
  }

  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4' };

  /* Lists every page of a channel's contents or of a user's channels. */
  async function listAll(client, path, query, checkAbort, maxPages = 500) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      checkAbort();
      const res = await client.request('GET', path, { query: { ...query, per: 100, page } });
      items.push(...(res?.data || []));
      if (!res?.meta?.has_more_pages) break;
    }
    return items;
  }

  async function runImport({ plan, client, journal, me, imageMode = 'url', signal, fetchImpl, emit = () => {}, persist = () => {} }) {
    const doFetch = fetchImpl || ((...args) => fetch(...args));
    const resolve = refResolver(client);
    const counts = { channelsCreated: 0, channelsReused: 0, created: 0, connected: 0, linked: 0, skipped: 0, failed: 0, nested: 0 };
    const failures = [];
    const total = plan.channels.length + plan.steps.length + plan.nests.length;
    let done = 0;
    const tick = () => emit({ type: 'progress', done, total, counts: { ...counts } });
    const log = (level, message, extra = {}) => emit({ type: 'log', level, message, ...extra });
    const checkAbort = () => {
      if (signal?.aborted) throw new AbortedError();
    };

    if (me && !(client instanceof DryRunClient)) {
      await verifyJournal();
      await reconcile();
    }

    emit({ type: 'phase', label: 'Creating channels' });
    for (const ch of plan.channels) {
      checkAbort();
      if (journal.channels[ch.key]) {
        counts.channelsReused++;
      } else {
        const created = await client.request('POST', '/channels', {
          body: clean({ title: ch.title, visibility: ch.visibility, description: ch.description, metadata: ch.metadata }),
        });
        journal.channels[ch.key] = pickChannel(created);
        counts.channelsCreated++;
        log('ok', `Channel created: ${ch.title}`);
        persist(journal);
      }
      emit({ type: 'channel', key: ch.key, channel: journal.channels[ch.key] });
      done++;
      tick();
    }

    emit({ type: 'phase', label: 'Transferring items' });
    for (const step of plan.steps) {
      checkAbort();
      const channel = journal.channels[step.channelKey];
      const linkKey = (blockId) => `${blockId}>${channel.id}`;
      try {
        const existing = journal.blocks[step.blockKey];
        if (step.target && (await linkOriginal(step, channel))) {
          /* linked to the original block or channel */
        } else if (!step.payload) {
          throw new ArenaError(404, 'The Are.na original is unavailable, and there is nothing to copy instead');
        } else if (existing && journal.links[linkKey(existing)]) {
          counts.skipped++;
        } else if (existing && (await connectBlock(existing, channel.id))) {
          journal.links[linkKey(existing)] = 1;
          counts.connected++;
        } else {
          const block = await createBlock(step, channel.id);
          journal.blocks[step.blockKey] = block.id;
          journal.links[linkKey(block.id)] = 1;
          counts.created++;
        }
        persist(journal);
      } catch (err) {
        if (isFatal(err)) throw err;
        counts.failed++;
        failures.push({ blockKey: step.blockKey, channelKey: step.channelKey, url: step.url, error: err.message });
        log('error', `Failed: ${err.message}`, { url: step.url });
      }
      done++;
      tick();
    }

    if (plan.nests.length) emit({ type: 'phase', label: 'Placing sub-channels' });
    for (const { childKey, parentKey } of plan.nests) {
      checkAbort();
      const child = journal.channels[childKey];
      const parent = journal.channels[parentKey];
      const key = child && parent && `${child.id}>${parent.id}`;
      if (key && !journal.nests[key]) {
        try {
          await client.request('POST', '/connections', {
            body: { connectable_id: child.id, connectable_type: 'Channel', channel_ids: [parent.id] },
          });
          counts.nested++;
        } catch (err) {
          if (isFatal(err)) throw err;
          if (err.status !== 422) log('warn', `Sub-channel not placed (${child.title}): ${err.message}`);
        }
        journal.nests[key] = 1;
        persist(journal);
      }
      done++;
      tick();
    }

    emit({ type: 'done', counts, failures });
    return { counts, failures };

    function isFatal(err) {
      return err instanceof AbortedError || [0, 401, 403].includes(err.status) || (err.status === 404 && err.channel);
    }

    async function linkOriginal(step, channel) {
      const ref = await resolve(step.target);
      if (!ref) {
        log('warn', 'Are.na original missing or private: a copy is made instead.', { url: step.url });
        return false;
      }
      const key = refLinkKey(ref, channel.id);
      if (journal.links[key]) {
        counts.skipped++;
        return true;
      }
      if (!(await connectRef(client, ref, channel.id, { metadata: step.linkMetadata }))) {
        resolve.unavailable(step.target);
        log('warn', 'Are.na won’t connect the original: a copy is made instead.', { url: step.url });
        return false;
      }
      journal.links[key] = 1;
      counts.linked++;
      return true;
    }

    async function connectBlock(blockId, channelId) {
      try {
        await client.request('POST', '/connections', {
          body: { connectable_id: blockId, connectable_type: 'Block', channel_ids: [channelId] },
        });
        return true;
      } catch (err) {
        if (err.status === 422) return true;
        if (err.status === 404) return false;
        throw err;
      }
    }

    async function createBlock(step, channelId) {
      const body = { ...step.payload, channel_ids: [channelId] };
      if (step.mediaUrl && imageMode === 'upload') body.value = await uploadMedia(step.mediaUrl);
      try {
        return await client.request('POST', '/blocks', { body });
      } catch (err) {
        if (err.status === 404) err.channel = true;
        if (!step.mediaUrl || imageMode === 'upload' || ![400, 422].includes(err.status)) throw err;
        log('warn', 'Are.na couldn’t fetch the file from its link, uploading it directly…', { url: step.url });
        body.value = await uploadMedia(step.mediaUrl);
        return await client.request('POST', '/blocks', { body });
      }
    }

    async function uploadMedia(url) {
      if (client instanceof DryRunClient) return `${S3_TEMP}simulation`;
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !MEDIA_HOSTS.test(parsed.hostname)) {
        throw new ArenaError(400, `Refusing to download a file from ${parsed.hostname}`);
      }
      const res = await doFetch(parsed.href, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new ArenaError(res.status, `Source file unavailable (${res.status})`);
      const blob = await res.blob();
      const type = blob.type || 'image/jpeg';
      const name = parsed.pathname.split('/').pop().replace(/\.\w+$/, '').replace(/[^\w-]/g, '') || 'file';
      const presign = await client.request('POST', '/uploads/presign', {
        body: { files: [{ filename: `${name}.${MIME_EXT[type] || 'bin'}`, content_type: type }] },
      });
      const file = presign.files[0];
      const put = await doFetch(file.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.content_type || type },
        body: blob,
        signal,
        credentials: 'omit',
      });
      if (!put.ok) throw new ArenaError(put.status, `Upload refused (${put.status})`);
      return S3_TEMP + file.key;
    }

    /* Drops from the journal the channels deleted on Are.na since. */
    async function verifyJournal() {
      const keys = plan.channels.map((c) => c.key).filter((k) => journal.channels[k]);
      if (!keys.length) return;
      emit({ type: 'phase', label: 'Checking channels from earlier runs' });
      for (const key of keys) {
        checkAbort();
        const { id } = journal.channels[key];
        try {
          const ch = await client.request('GET', `/channels/${id}`);
          if (ch?.state === 'deleted') throw new ArenaError(404, 'deleted');
        } catch (err) {
          if (err.status !== 404) throw err;
          delete journal.channels[key];
          for (const k of Object.keys(journal.links)) if (k.endsWith(`>${id}`)) delete journal.links[k];
          log('warn', `The channel “${plan.channels.find((c) => c.key === key).title}” no longer exists: it will be created again.`);
        }
      }
      persist(journal);
    }

    /* Without a local journal (other browser, cleared data), finds an earlier run through the metadata. */
    async function reconcile() {
      const missing = new Set(plan.channels.map((c) => c.key).filter((k) => !journal.channels[k]));
      if (!missing.size) return;
      emit({ type: 'phase', label: 'Looking for an earlier run on Are.na' });
      const found = [];
      for (const ch of await listAll(client, `/users/${me.id}/contents`, { type: 'Channel' }, checkAbort, 50)) {
        const key = collectionKey(ch.metadata);
        if (key && missing.has(key) && ch.state !== 'deleted') {
          journal.channels[key] = pickChannel(ch);
          missing.delete(key);
          found.push(journal.channels[key]);
        }
      }
      for (const ch of found) {
        log('info', `Earlier run found: ${ch.title}`);
        for (const item of await listAll(client, `/channels/${ch.id}/contents`, {}, checkAbort)) {
          const linked = metaSource(item.connection?.metadata, 'item');
          if (item.type === 'Channel') {
            if (linked) journal.links[refLinkKey({ type: 'Channel', id: item.id }, ch.id)] = 1;
            else if (collectionKey(item.metadata)) journal.nests[`${item.id}>${ch.id}`] = 1;
          } else if (itemKey(item.metadata)) {
            journal.blocks[itemKey(item.metadata)] = item.id;
            journal.links[`${item.id}>${ch.id}`] = 1;
          } else if (linked) {
            journal.links[`${item.id}>${ch.id}`] = 1;
          }
        }
      }
      persist(journal);
    }
  }

  return {
    API,
    FREE_TIER_LIMIT,
    SOURCES,
    AbortedError,
    ArenaError,
    ArenaClient,
    DryRunClient,
    arenaRef,
    blockPayloads,
    buildPlan,
    checkWriteAccess,
    elementSteps,
    emptyJournal,
    normalizeExport,
    normalizeUrl,
    runImport,
    safeMediaUrl,
  };
});
