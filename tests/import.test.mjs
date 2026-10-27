// Tests for the import and repair engine, against an in-memory fake of the Are.na API.
// Run: node tests/import.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const T = require(new URL('../arena.js', import.meta.url).pathname);

/* ───────── Synthetic Cosmos export (first file format, as made by version 1) ───────── */

const ORIGINAL_BLOCK = 555; // public block that already exists on Are.na
const ORIGINAL_IMAGE = 556; // block whose image was saved from Are.na's CDN
const PRIVATE_BLOCK = 666; // missing or private block → a copy is made instead
const ORIGINAL_CHANNEL = { id: 777, slug: 'motion-theory-xmxi9axgqgm' };

const cosmosElements = {};
const ids = [];
for (let i = 0; i < 60; i++) {
  const id = String(1000 + i);
  const img = (k, type = 'StaticImage') => ({ type, url: `https://cdn.cosmos.so/test-${id}-${k}`, width: 800, height: 1000 });
  let kind = i % 15 === 7 ? 'website' : i % 20 === 11 ? 'text' : 'media';
  let source = i % 4
    ? { url: i % 8 ? `https://www.pinterest.com/pin/${id}/` : `itsnicethat.com/articles/${id}`, author: i % 2 ? { name: `Author ${i}`, username: `a${i}`, url: `https://www.instagram.com/a${i}` } : null }
    : null;
  if (i === 2) source = { url: `https://www.are.na/block/${ORIGINAL_BLOCK}`, author: null };
  if (i === 5) source = { url: `https://d2w9rnfcy7mm78.cloudfront.net/${ORIGINAL_IMAGE}/original_x.jpg?1?bc=0`, author: null };
  if (i === 8) source = { url: `https://are.na/block/${PRIVATE_BLOCK}`, author: null };
  if (i === 9) {
    kind = 'website';
    source = { url: `https://www.are.na/someone/${ORIGINAL_CHANNEL.slug}`, author: null };
  }
  cosmosElements[id] = {
    id,
    kind,
    createdAt: '2025-01-01T00:00:00Z',
    cosmosUrl: `https://www.cosmos.so/e/${id}`,
    caption: i % 3 ? `Poster no. ${i} by A.B. Studio, 2024. Photo by J. Doe.` : '',
    source,
    media: kind === 'text' ? [] : i % 9 === 4 ? [img(0), img(1), img(2)] : i % 10 === 3 ? [img(0, 'Video')] : i % 10 === 6 ? [img(0, 'AnimatedImage')] : [img(0)],
    title: kind === 'website' ? `Site ${i}` : null,
    description: kind === 'website' ? 'A website' : null,
    brand: null,
    text: kind === 'text' ? `Note ${i}` : null,
  };
  ids.push(id);
}
// Collections: A (0-29), B (20-49, overlaps A), C sub-collection of A (0-5)
const cosmos = T.normalizeExport({
  schema: 'cosmos-export/1',
  user: { id: '1', username: 'test' },
  elements: cosmosElements,
  collections: [
    { id: '1', name: 'Type', slug: 'type', description: 'Lettering', isPrivate: false, parentId: null, elementIds: ids.slice(0, 30) },
    { id: '2', name: 'Objects', slug: 'objects', description: '', isPrivate: true, parentId: null, elementIds: ids.slice(20, 50) },
    { id: '3', name: 'Posters', slug: 'posters', description: '', isPrivate: false, parentId: '1', elementIds: ids.slice(0, 6) },
  ],
  library: { elementIds: ids.slice(0, 50) },
});

/* ───────── Synthetic Pinterest export ───────── */

const pins = {};
const pinIds = [];
for (let i = 0; i < 24; i++) {
  const id = String(900000000000 + i);
  const img = (k) => ({ type: 'StaticImage', url: `https://i.pinimg.com/originals/aa/bb/cc/${id}-${k}.jpg`, width: 1000, height: 1500 });
  pins[id] = {
    id,
    kind: 'media',
    url: `https://www.pinterest.com/pin/${id}/`,
    caption: '',
    source: { url: i === 3 ? `https://www.are.na/block/${ORIGINAL_BLOCK}` : i % 2 ? `https://example.com/article-${i}` : `https://www.pinterest.com/pin/${id}/`, author: null },
    media: i % 6 === 1 ? [img(0), img(1)] : i % 7 === 2 ? [{ type: 'Video', url: `https://v1.pinimg.com/videos/iht/720p/${id}.mp4` }] : [img(0)],
    title: i % 3 ? `Pin ${i}` : null,
    description: i % 4 ? `Description of pin ${i}` : null,
    alt: i % 5 ? `Alt text ${i}` : null,
  };
  pinIds.push(id);
}
const pinterest = T.normalizeExport({
  schema: 'arena-import/1',
  source: 'pinterest',
  user: { id: '9', username: 'someone' },
  elements: pins,
  library: null,
  collections: [
    { id: '7001', name: 'Interiors', slug: 'interiors', isPrivate: false, parentId: null, includesChildren: true, elementIds: pinIds.slice(0, 16) },
    { id: '8001', name: 'Kitchens', slug: 'kitchens', isPrivate: false, parentId: '7001', elementIds: pinIds.slice(4, 9) },
    { id: '7002', name: 'Secret moodboard', slug: 'secret', isPrivate: true, parentId: null, includesChildren: true, elementIds: pinIds.slice(12, 24) },
  ],
});

/* ───────── Fake Are.na API ─────────
 * As on Are.na: position 1 is the bottom of a channel, the highest the top (latest additions).
 * items[] runs from bottom to top; position = index + 1.
 */
function mockArena({ rate429Every = 0, fail500Once = true, readOnly = false, noBatch = false } = {}) {
  const S = { channels: new Map(), blocks: new Map(), nextId: 1000, nextConn: 1, writes: 0, did500: false };
  for (const id of [ORIGINAL_BLOCK, ORIGINAL_IMAGE]) S.blocks.set(id, { id, external: true, kind: 'Image', title: 'original' });
  S.channels.set(ORIGINAL_CHANNEL.id, { id: ORIGINAL_CHANNEL.id, slug: ORIGINAL_CHANNEL.slug, title: 'Motion Theory', metadata: null, items: [], state: 'available', external: true });

  const json = (status, body, extra = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'x-ratelimit-remaining': '50', ...extra }),
    text: async () => (body == null ? '' : JSON.stringify(body)),
  });
  const page = (arr, q) => {
    const per = +q.get('per') || 24;
    const p = +q.get('page') || 1;
    return { data: arr.slice((p - 1) * per, p * per), meta: { has_more_pages: p * per < arr.length } };
  };
  const findChannel = (idOrSlug) => S.channels.get(+idOrSlug) || [...S.channels.values()].find((c) => c.slug === idOrSlug);
  const connect = (c, item, position, metadata) => {
    const entry = { ...item, connId: S.nextConn++, metadata: metadata || null };
    if (position) c.items.splice(position - 1, 0, entry);
    else c.items.push(entry);
  };
  const itemView = (it, index) => {
    const connection = { id: it.connId, position: index + 1, metadata: it.metadata };
    if (it.type === 'Channel') {
      const ch = S.channels.get(it.id);
      return { id: ch.id, type: 'Channel', title: ch.title, metadata: ch.metadata, connection };
    }
    const b = S.blocks.get(it.id);
    if (b.external) return { id: b.id, type: b.kind, title: b.title, metadata: null, source: null, connection };
    return { id: b.id, type: b.kind, title: b.title, metadata: b.metadata, source: b.sourceUrl ? { url: b.sourceUrl } : null, connection };
  };

  const fetchImpl = async (url, { method, body, headers }) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/v3', ''));
    const b = body ? JSON.parse(body) : null;
    assert.equal(headers.Authorization, 'Bearer test-token');
    if (method !== 'GET' && readOnly) return json(403, { error: 'Forbidden', code: 403, details: { message: 'You do not have permission to access this resource.' } });
    if (method !== 'GET') {
      S.writes++;
      if (rate429Every && S.writes % rate429Every === 0) return json(429, { error: 'Too Many Requests' }, { 'retry-after': '0.05' });
      if (fail500Once && !S.did500 && S.writes === 7) {
        S.did500 = true;
        return json(502, null);
      }
    }
    let m;
    if (method === 'GET' && (m = path.match(/^\/users\/(\d+)\/contents$/))) {
      const mine = [...S.channels.values()].filter((c) => !c.external && c.state !== 'deleted');
      return json(200, page(mine.map((c) => ({ id: c.id, type: 'Channel', slug: c.slug, title: c.title, metadata: c.metadata, state: c.state, visibility: c.visibility, length: c.items.length })), u.searchParams));
    }
    if (method === 'GET' && (m = path.match(/^\/channels\/([^/]+)$/))) {
      const c = findChannel(m[1]);
      return c ? json(200, { id: c.id, slug: c.slug, title: c.title, state: c.state, visibility: c.visibility, metadata: c.metadata, owner: { slug: 'me' } }) : json(404, { error: 'Not Found' });
    }
    if (method === 'GET' && (m = path.match(/^\/channels\/(\d+)\/contents$/))) {
      const c = S.channels.get(+m[1]);
      return json(200, page(c.items.map(itemView).reverse(), u.searchParams)); // top to bottom, like Are.na
    }
    if (method === 'POST' && path === '/channels') {
      assert.ok(b.title);
      assert.ok(['public', 'private', 'closed'].includes(b.visibility));
      for (const k of Object.keys(b.metadata || {})) assert.match(k, /^\w{1,40}$/);
      const id = S.nextId++;
      S.channels.set(id, { id, slug: `ch-${id}`, title: b.title, visibility: b.visibility, metadata: b.metadata, items: [], state: 'available' });
      return json(201, { id, slug: `ch-${id}`, title: b.title, owner: { slug: 'me' } });
    }
    if (method === 'POST' && path === '/blocks') {
      assert.ok(b.value, 'value is required');
      assert.equal(b.channel_ids.length, 1);
      for (const k of Object.keys(b.metadata || {})) assert.match(k, /^\w{1,40}$/);
      if (b.original_source_url) assert.match(new URL(b.original_source_url).protocol, /^https?:$/);
      const c = S.channels.get(b.channel_ids[0]);
      if (!c) return json(404, { error: 'Not Found' });
      const isUrl = /^https?:\/\//.test(b.value);
      const kind = !isUrl ? 'Text' : /^https:\/\/(cdn\.cosmos\.so|i\.pinimg\.com|v1\.pinimg\.com)\//.test(b.value) ? 'Image' : 'Link';
      const id = S.nextId++;
      S.blocks.set(id, { id, kind, title: b.title || '', metadata: b.metadata, sourceUrl: kind === 'Link' ? b.value : b.original_source_url || null, payload: b });
      connect(c, { type: 'Block', id });
      return json(201, { id, type: 'PendingBlock' });
    }
    if (method === 'POST' && path === '/blocks/batch') {
      if (noBatch) return json(403, { error: 'Forbidden', code: 403, details: { message: 'Premium subscription required' } });
      assert.ok(Array.isArray(b.channel_ids) && b.channel_ids.length);
      assert.ok(Array.isArray(b.blocks) && b.blocks.length <= 50);
      const targets = b.channel_ids.map((id) => S.channels.get(id));
      if (targets.some((c) => !c)) return json(404, { error: 'Not Found' });
      if (targets.some((c) => c.visibility !== 'private')) return json(422, { error: 'Batch destinations must be private' });
      const batchId = `test-batch-${S.nextId++}`;
      const successful = [];
      b.blocks.forEach((blk, index) => {
        assert.ok(blk.value, 'batch block value is required');
        const isUrl = /^https?:\/\//.test(blk.value);
        const kind = !isUrl ? 'Text' : /^https:\/\/(cdn\.cosmos\.so|i\.pinimg\.com|v1\.pinimg\.com)\//.test(blk.value) ? 'Image' : 'Link';
        const id = S.nextId++;
        S.blocks.set(id, { id, kind, title: blk.title || '', metadata: blk.metadata, sourceUrl: kind === 'Link' ? blk.value : blk.original_source_url || null, payload: blk });
        for (const c of targets) connect(c, { type: 'Block', id });
        successful.push({ index, block_id: id });
      });
      S.batches = S.batches || new Map();
      S.batches.set(batchId, { batch_id: batchId, status: 'completed', total: b.blocks.length, successful_count: successful.length, failed_count: 0, successful, failed: [], created_at: new Date().toISOString(), completed_at: new Date().toISOString() });
      return json(202, { batch_id: batchId, status: 'pending', total: b.blocks.length });
    }
    if (method === 'GET' && (m = path.match(/^\/blocks\/batch\/(.+)$/))) {
      const batch = S.batches?.get(m[1]);
      return batch ? json(200, batch) : json(404, { error: 'Not Found' });
    }
    if (method === 'POST' && path === '/connections') {
      const targets = b.channels || (b.channel_ids || []).map((id) => ({ id }));
      assert.equal(targets.length, 1);
      const c = findChannel(targets[0].id);
      if (!c) return json(404, {});
      const exists = b.connectable_type === 'Block' ? S.blocks.has(b.connectable_id) : S.channels.has(b.connectable_id);
      if (!exists) return json(404, { error: 'Not Found' });
      if (c.items.some((it) => it.type === b.connectable_type && it.id === b.connectable_id)) return json(422, { error: 'Already connected' });
      connect(c, { type: b.connectable_type, id: b.connectable_id }, targets[0].position, targets[0].metadata);
      return json(201, [{ id: S.nextConn }]);
    }
    if (method === 'DELETE' && (m = path.match(/^\/connections\/(\d+)$/))) {
      for (const c of S.channels.values()) {
        const i = c.items.findIndex((it) => it.connId === +m[1]);
        if (i >= 0) {
          c.items.splice(i, 1);
          return json(204, null);
        }
      }
      return json(404, {});
    }
    if (method === 'PUT' && (m = path.match(/^\/channels\/(\d+)$/))) {
      const c = S.channels.get(+m[1]);
      if (!c) return json(404, { error: 'Not Found' });
      for (const k of Object.keys(b.metadata || {})) assert.match(k, /^\w{1,40}$/);
      const merged = { ...c.metadata, ...b.metadata }; // like Are.na: keys are added or updated, null removes
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      c.metadata = merged;
      if (b.title) c.title = b.title;
      return json(200, { id: c.id, slug: c.slug, title: c.title, metadata: c.metadata });
    }
    if (method === 'PUT' && (m = path.match(/^\/blocks\/(\d+)$/))) {
      S.blocks.get(+m[1]).title = b.title;
      return json(200, { id: +m[1], title: b.title });
    }
    throw new Error(`not handled: ${method} ${path}`);
  };
  return { S, fetchImpl };
}

const me = { id: 42, slug: 'me' };
const client = (fetchImpl, extra = {}) => new T.ArenaClient('test-token', { fetchImpl, writeGap: 0, ...extra });
const channelOf = (S, id) => [...S.channels.values()].find((c) => c.metadata?.cosmos_cluster_id === id || c.metadata?.pinterest_board_id === id);
const itemOf = (b) => `${b.metadata.cosmos_element_id ?? b.metadata.pinterest_pin_id}:${b.metadata.cosmos_media_index ?? b.metadata.pinterest_media_index}`;

/* A channel's content from top to bottom, as readable strings. */
function display(S, collectionId) {
  return [...channelOf(S, collectionId).items].reverse().map((it) => {
    if (it.type === 'Channel') return S.channels.get(it.id).external ? `channel:${it.id}` : 'sub-channel';
    const b = S.blocks.get(it.id);
    return b.external ? `original:${b.id}` : itemOf(b);
  });
}

/* What a Cosmos collection should hold on Are.na, from top to bottom. */
function expectedCosmos(collection, { carousel, arenaLinks }) {
  return collection.elementIds.flatMap((id) => {
    const el = cosmos.elements[id];
    if (arenaLinks) {
      if (id === '1002') return [`original:${ORIGINAL_BLOCK}`];
      if (id === '1005') return [`original:${ORIGINAL_IMAGE}`];
      if (id === '1009') return [`channel:${ORIGINAL_CHANNEL.id}`];
    }
    if (el.kind === 'website' || el.kind === 'text') return [`${id}:0`];
    const n = carousel === 'all' ? el.media.length : 1;
    return el.media.slice(0, n).map((_, i) => `${id}:${i}`);
  });
}

function checkCosmos(S, options, label) {
  for (const col of cosmos.collections) {
    const got = display(S, col.id).filter((x) => x !== 'sub-channel');
    assert.deepEqual(got, expectedCosmos(col, options), `${label}: content and order of “${col.name}”`);
  }
  const type = channelOf(S, '1');
  const posters = channelOf(S, '3');
  assert.ok(type.items.some((i) => i.type === 'Channel' && i.id === posters.id), `${label}: sub-collection placed`);
}

const ALL_COPIES = { carousel: 'all', arenaLinks: false }; // behaviour of the first version
const NEW_DEFAULTS = { carousel: 'first', arenaLinks: true };
const cosmosOptions = { selected: ['1', '2', '3'], includeLibrary: true, visibility: 'mirror', nest: true };

/* 0. Export files and Are.na links */
{
  assert.equal(cosmos.source, 'cosmos');
  assert.equal(cosmos.elements['1000'].url, 'https://www.cosmos.so/e/1000', 'legacy cosmosUrl becomes url');
  assert.throws(() => T.normalizeExport({ schema: 'other' }), /not made by the export script/);
  assert.throws(() => T.normalizeExport({ schema: 'arena-import/1', source: 'tumblr', collections: [], elements: {} }), /Unknown source/);

  assert.deepEqual(T.arenaRef('https://www.are.na/block/19141539'), { type: 'Block', id: 19141539 });
  assert.deepEqual(T.arenaRef('https://d2w9rnfcy7mm78.cloudfront.net/43787650/original_865e.jpg?1771625158?bc=0'), { type: 'Block', id: 43787650 });
  assert.deepEqual(T.arenaRef('https://are.na/spencer-elias/threshold-study'), { type: 'Channel', slug: 'threshold-study' });
  assert.equal(T.arenaRef('https://www.are.na/romain-pedeboscq/references-mockup', { channels: false }), null);
  assert.equal(T.arenaRef('https://www.are.na/editorial/building-together'), null);
  assert.equal(T.arenaRef('https://www.are.na/romain-pedeboscq'), null);
  assert.equal(T.arenaRef('https://www.pinterest.com/pin/1/'), null);

  assert.equal(T.normalizeUrl('javascript:alert(1)'), null);
  assert.equal(T.normalizeUrl('data:text/html,hi'), null);
  assert.equal(T.normalizeUrl('itsnicethat.com/articles/x'), 'https://itsnicethat.com/articles/x');
  assert.equal(T.safeMediaUrl('http://cdn.cosmos.so/x'), null, 'media must be https');
  const hostile = { id: 'x', kind: 'media', url: 'javascript:alert(1)', source: { url: 'javascript:alert(1)' }, media: [{ type: 'StaticImage', url: 'javascript:alert(1)' }] };
  assert.deepEqual(T.blockPayloads(hostile), [], 'unsafe media is dropped');
  console.log('✓ export files, Are.na links, unsafe URLs');
}

/* Token check: a read-only token is told apart without anything being changed */
{
  const writable = mockArena({ fail500Once: false });
  assert.equal(await T.checkWriteAccess(client(writable.fetchImpl)), true);
  assert.equal(writable.S.channels.size, 1, 'nothing created by the check');
  const readOnly = mockArena({ fail500Once: false, readOnly: true });
  assert.equal(await T.checkWriteAccess(client(readOnly.fetchImpl)), false);
  console.log('✓ write access check');
}

/* 1. Cosmos plan: carousels and Are.na originals */
{
  const first = T.buildPlan(cosmos, { ...cosmosOptions, ...NEW_DEFAULTS });
  const all = T.buildPlan(cosmos, { ...cosmosOptions, ...ALL_COPIES });
  assert.deepEqual(first.channels.map((c) => c.key), ['1', '2', '3', '__library__'], 'parents before children, keys of version 1');
  assert.deepEqual(first.channels[0].metadata, { cosmos_cluster_id: '1', cosmos_slug: 'type' });
  assert.ok(first.stats.blocks < all.stats.blocks);
  assert.ok(first.steps.every((s) => s.blockKey.endsWith(':0')), 'one image per carousel');
  assert.ok(first.stats.arena > 0 && all.stats.arena === 0);
  const carousel = T.blockPayloads(cosmos.elements['1004'], { carousel: 'all' });
  assert.equal(carousel.length, 3);
  assert.match(carousel[0].payload.title, /\(1\/3\)$/);
  assert.deepEqual(carousel[0].payload.metadata, { cosmos_element_id: '1004', cosmos_media_index: 0, cosmos_url: 'https://www.cosmos.so/e/1004' });
  console.log('✓ Cosmos plan', first.stats);
}

/* 2. Full Cosmos import, with rate limits and a 502 */
{
  const { S, fetchImpl } = mockArena({ rate429Every: 40 });
  const waits = [];
  const plan = T.buildPlan(cosmos, { ...cosmosOptions, ...NEW_DEFAULTS });
  const r = await T.runImport({ plan, client: client(fetchImpl, { onWait: (until) => until && waits.push(until) }), journal: T.emptyJournal(), me });
  assert.equal(r.failures.length, 0);
  assert.ok(waits.length > 0, 'waited on 429');
  assert.ok(r.counts.linked > 0, 'Are.na originals connected');
  checkCosmos(S, NEW_DEFAULTS, 'import');
  assert.ok([...S.blocks.values()].some((b) => b.metadata?.cosmos_element_id === '1008'), 'private original: a copy is made instead');
  console.log('✓ Cosmos import', r.counts);
}

/* 3. Pause, resume, lost journal, deleted channel */
{
  const { S, fetchImpl } = mockArena();
  const plan = T.buildPlan(cosmos, { ...cosmosOptions, ...NEW_DEFAULTS });
  const journal = T.emptyJournal();
  const ac = new AbortController();
  let n = 0;
  const pausing = async (...a) => {
    if (a[1].method !== 'GET' && ++n === 30) ac.abort();
    return fetchImpl(...a);
  };
  await assert.rejects(T.runImport({ plan, client: client(pausing, { signal: ac.signal }), journal, me, signal: ac.signal }), { name: 'AbortError' });
  const r2 = await T.runImport({ plan, client: client(fetchImpl), journal, me });
  checkCosmos(S, NEW_DEFAULTS, 'resume');

  const r3 = await T.runImport({ plan, client: client(fetchImpl), journal: T.emptyJournal(), me });
  assert.deepEqual([r3.counts.created, r3.counts.connected, r3.counts.linked, r3.counts.channelsCreated], [0, 0, 0, 0], 'journal rebuilt from Are.na');

  S.channels.delete(channelOf(S, '1').id);
  const r4 = await T.runImport({ plan, client: client(fetchImpl), journal: T.emptyJournal(), me });
  assert.equal(r4.counts.channelsCreated, 1);
  console.log('✓ resume', r2.counts.created, '· lost journal', r3.counts.skipped, 'skipped · channel created again');
}

/* 4. Pinterest: boards, sections, Are.na pins */
{
  const options = { selected: ['7001', '8001', '7002'], visibility: 'mirror', nest: true, ...NEW_DEFAULTS };
  const plan = T.buildPlan(pinterest, options);
  assert.deepEqual(plan.channels.map((c) => c.key), ['pinterest:7001', 'pinterest:7002', 'pinterest:8001']);
  assert.deepEqual(plan.channels[0].metadata, { pinterest_board_id: '7001', pinterest_slug: 'interiors' });
  assert.equal(plan.channels.find((c) => c.key === 'pinterest:7002').visibility, 'private');
  assert.equal(plan.channels[0].count, 16 - 5, 'section pins left out of the board channel');
  const withoutSection = T.buildPlan(pinterest, { ...options, selected: ['7001'] });
  assert.equal(withoutSection.channels[0].count, 16, 'board keeps every pin when its section is not imported');
  const flat = T.buildPlan(pinterest, { ...options, nest: false });
  assert.equal(flat.channels[0].count, 16, 'board keeps every pin when sections are not nested');

  const payload = T.blockPayloads(pinterest.elements[pinIds[1]], { source: 'pinterest' })[0].payload;
  assert.equal(payload.title, 'Pin 1');
  assert.equal(payload.description, 'Description of pin 1');
  assert.equal(payload.alt_text, 'Alt text 1');
  assert.equal(payload.original_source_url, 'https://example.com/article-1');
  assert.deepEqual(payload.metadata, { pinterest_pin_id: pinIds[1], pinterest_media_index: 0, pinterest_url: `https://www.pinterest.com/pin/${pinIds[1]}/` });

  const { S, fetchImpl } = mockArena();
  const journal = T.emptyJournal();
  const r = await T.runImport({ plan, client: client(fetchImpl), journal, me });
  assert.equal(r.failures.length, 0);
  const interiors = display(S, '7001');
  assert.equal(interiors[0], 'sub-channel', 'section placed inside its board');
  assert.ok(interiors.includes(`original:${ORIGINAL_BLOCK}`), 'pin saved from Are.na connects the original');
  assert.ok(!interiors.some((x) => pinIds.slice(4, 9).some((id) => x.startsWith(`${id}:`))), 'no section pin in the board channel');
  assert.deepEqual(display(S, '8001'), pinIds.slice(4, 9).map((id) => `${id}:0`));

  const lost = await T.runImport({ plan, client: client(fetchImpl), journal: T.emptyJournal(), me });
  assert.deepEqual([lost.counts.created, lost.counts.linked, lost.counts.channelsCreated], [0, 0, 0], 'Pinterest journal rebuilt from Are.na');

  console.log('✓ Pinterest', plan.stats, r.counts);
}

/* 5. Simulation */
{
  const plan = T.buildPlan(cosmos, { ...cosmosOptions, ...NEW_DEFAULTS });
  const r = await T.runImport({ plan, client: new T.DryRunClient(), journal: T.emptyJournal(), me: null });
  assert.equal(r.counts.created, plan.stats.blocks);
  console.log('✓ simulation', r.counts);
}

/* 6. Destinations: sending a collection into an existing channel, and prefixing nested names */
{
  /* A channel made by hand on Are.na: no source tag in its metadata. */
  const addChannel = (S, { id, slug, title, visibility = 'public', metadata = null }) =>
    S.channels.set(id, { id, slug, title, visibility, metadata, items: [], state: 'available' });
  const pick = (id, slug, title, visibility = 'public') => ({ channelId: id, slug, title, visibility });
  const spyOn = (fetchImpl) => {
    const calls = [];
    return { calls, fetchImpl: (url, init) => (calls.push(`${init.method} ${new URL(url).pathname.replace('/v3', '')}`), fetchImpl(url, init)) };
  };
  const pinOptions = { visibility: 'mirror', nest: true, ...NEW_DEFAULTS };

  /* Listing the user's channels */
  {
    const { S, fetchImpl } = mockArena({ fail500Once: false });
    addChannel(S, { id: 5001, slug: 'one', title: 'One' });
    addChannel(S, { id: 5002, slug: 'two', title: 'Two', visibility: 'private' });
    const list = await T.listUserChannels(client(fetchImpl), me, () => {});
    assert.deepEqual(list.map((c) => [c.id, c.slug, c.title, c.visibility, c.length]), [[5001, 'one', 'One', 'public', 0], [5002, 'two', 'Two', 'private', 0]]);
    assert.ok(list.every((c) => 'metadata' in c), 'metadata is kept');
  }

  /* Backward compatibility: the new options absent, empty or off change nothing */
  {
    const base = T.buildPlan(pinterest, { ...pinOptions, selected: ['7001', '8001', '7002'] });
    const same = (extra) => assert.deepEqual(T.buildPlan(pinterest, { ...pinOptions, selected: ['7001', '8001', '7002'], ...extra }), base);
    same({ destinations: {} });
    same({ prefixNested: false });
    same({ destinations: { 7001: 'new' } });
    assert.ok(base.channels.every((c) => !Object.keys(c).some((k) => k.startsWith('target'))), 'no target fields by default');
    const cosmosWith = (extra) => T.buildPlan(cosmos, { ...cosmosOptions, ...NEW_DEFAULTS, ...extra });
    assert.deepEqual(cosmosWith({ destinations: {}, prefixNested: false }), cosmosWith({}));
  }

  /* Plan: mix of new and existing, the library stays new-only */
  {
    const plan = T.buildPlan(pinterest, { ...pinOptions, selected: ['7001', '8001', '7002'], destinations: { 7001: pick(5002, 'mine', 'mine'), 7002: 'new' } });
    const by = (key) => plan.channels.find((c) => c.key === key);
    assert.deepEqual(
      [by('pinterest:7001').targetChannelId, by('pinterest:7001').targetSlug, by('pinterest:7001').targetTitle, by('pinterest:7001').targetVisibility],
      [5002, 'mine', 'mine', 'public']
    );
    assert.equal(by('pinterest:7001').title, 'Interiors', 'source title is kept on the plan');
    assert.equal(by('pinterest:7002').targetChannelId, undefined);
    assert.equal(by('pinterest:8001').targetChannelId, undefined);
    assert.equal(by('pinterest:8001').parentKey, 'pinterest:7001', 'nesting still resolves');

    const withLibrary = T.buildPlan(cosmos, { ...cosmosOptions, ...NEW_DEFAULTS, destinations: { __library__: pick(5009, 'lib', 'lib') } });
    assert.equal(withLibrary.channels.find((c) => c.key === '__library__').targetChannelId, undefined, 'library is always new');
  }

  /* Plan: names of nested channels */
  {
    const chain = T.normalizeExport({
      schema: 'cosmos-export/1',
      user: { id: '1', username: 'test' },
      elements: {},
      collections: [
        { id: 'a', name: 'A', parentId: null, elementIds: [] },
        { id: 'b', name: 'B', parentId: 'a', elementIds: [] },
        { id: 'c', name: 'C', parentId: 'b', elementIds: [] },
      ],
    });
    const titles = (extra) => Object.fromEntries(T.buildPlan(chain, { selected: ['a', 'b', 'c'], ...extra }).channels.map((c) => [c.key, c.title]));
    assert.deepEqual(titles({}), { a: 'A', b: 'B', c: 'C' }, 'off: unchanged');
    assert.deepEqual(titles({ prefixNested: true }), { a: 'A', b: 'A - B', c: 'A - B - C' }, 'walks the whole chain');
    assert.deepEqual(titles({ prefixNested: true, destinations: { a: pick(1, 'x', 'drawing') } }), { a: 'A', b: 'drawing - B', c: 'drawing - B - C' }, 'a picked parent lends its own title');
    assert.deepEqual(titles({ prefixNested: true, destinations: { b: pick(2, 'y', 'Middle') } }), { a: 'A', b: 'B', c: 'A - Middle - C' }, 'a picked channel is not renamed');
    assert.deepEqual(titles({ prefixNested: true, nest: false }), { a: 'A', b: 'A - B', c: 'A - B - C' }, 'flattened children keep their lineage');
    assert.ok(T.buildPlan(chain, { selected: ['a', 'b', 'c'], prefixNested: true, nest: false }).channels.every((c) => c.parentKey === null));
    assert.deepEqual(titles({ prefixNested: true, selected: ['b', 'c'] }), { b: 'B', c: 'B - C' }, 'a parent that is not selected is not used');
  }

  /* Run: pick an existing channel, no journal; then run again with the journal; the source stays private, the channel stays public */
  {
    const { S, fetchImpl } = mockArena({ fail500Once: false });
    addChannel(S, { id: 5001, slug: 'moodboard', title: 'moodboard', visibility: 'public' });
    const spy = spyOn(fetchImpl);
    const plan = T.buildPlan(pinterest, { ...pinOptions, selected: ['7002'], destinations: { 7002: pick(5001, 'moodboard', 'moodboard', 'public') } });
    assert.equal(plan.channels[0].visibility, 'private');
    const journal = T.emptyJournal();
    const r = await T.runImport({ plan, client: client(spy.fetchImpl), journal, me });
    assert.equal(r.failures.length, 0);
    assert.ok(!spy.calls.includes('POST /channels'), 'no channel is created');
    assert.deepEqual([r.counts.channelsCreated, r.counts.channelsReused], [0, 1]);
    assert.equal(journal.channels['pinterest:7002'].id, 5001);
    assert.equal(S.channels.get(5001).items.length, 12, 'blocks are added to the picked channel');
    assert.equal(S.channels.get(5001).visibility, 'public', 'visibility of a picked channel is left alone');
    assert.equal([...S.channels.values()].filter((c) => !c.external).length, 1, 'nothing else was made');

    spy.calls.length = 0;
    const again = await T.runImport({ plan, client: client(spy.fetchImpl), journal, me });
    assert.ok(!spy.calls.includes('POST /channels') && !spy.calls.includes('POST /blocks'));
    assert.deepEqual([again.counts.created, again.counts.channelsCreated, again.counts.channelsReused], [0, 0, 1]);
    assert.ok(again.counts.skipped > 0, 'earlier work is recognised');
    assert.equal(S.channels.get(5001).items.length, 12);
  }

  /* Run: new and existing together, with a prefixed sub-channel inside the picked one */
  {
    const { S, fetchImpl } = mockArena({ fail500Once: false });
    addChannel(S, { id: 5002, slug: 'interiors-mine', title: 'interiors (mine)' });
    const plan = T.buildPlan(pinterest, {
      ...pinOptions,
      selected: ['7001', '8001', '7002'],
      prefixNested: true,
      destinations: { 7001: pick(5002, 'interiors-mine', 'interiors (mine)'), 7002: 'new' },
    });
    const r = await T.runImport({ plan, client: client(fetchImpl), journal: T.emptyJournal(), me });
    assert.equal(r.failures.length, 0);
    assert.deepEqual([r.counts.channelsCreated, r.counts.channelsReused], [2, 1]);
    const kitchens = channelOf(S, '8001');
    assert.equal(kitchens.title, 'interiors (mine) - Kitchens');
    assert.equal(channelOf(S, '7002').title, 'Secret moodboard');
    assert.equal(channelOf(S, '7001')?.id, 5002, 'the picked channel is tagged for next time');
    assert.ok(S.channels.get(5002).items.some((i) => i.type === 'Channel' && i.id === kitchens.id), 'sub-channel placed inside the picked channel');
  }

  /* Run: the picked channel was deleted since the pick */
  {
    const { S, fetchImpl } = mockArena({ fail500Once: false });
    const plan = T.buildPlan(pinterest, { ...pinOptions, selected: ['7002'], destinations: { 7002: pick(5003, 'gone', 'gone') } });
    const logs = [];
    const journal = T.emptyJournal();
    const r = await T.runImport({ plan, client: client(fetchImpl), journal, me, emit: (e) => e.type === 'log' && logs.push(e) });
    assert.equal(r.failures.length, 0);
    assert.deepEqual([r.counts.channelsCreated, r.counts.channelsReused], [1, 0], 'a new channel is made instead');
    assert.ok(logs.some((l) => l.level === 'warn' && /gone/.test(l.message)), 'the fallback is logged');
    assert.equal(channelOf(S, '7002').title, 'Secret moodboard');
    assert.notEqual(journal.channels['pinterest:7002'].id, 5003);
  }

  /* Simulation: no stubs needed, nothing is read or written */
  {
    const plan = T.buildPlan(pinterest, { ...pinOptions, selected: ['7002'], destinations: { 7002: pick(5001, 'moodboard', 'moodboard') } });
    const channels = [];
    const r = await T.runImport({ plan, client: new T.DryRunClient(), journal: T.emptyJournal(), me: null, emit: (e) => e.type === 'channel' && channels.push(e.channel) });
    assert.deepEqual([r.counts.channelsCreated, r.counts.channelsReused], [0, 1]);
    assert.deepEqual([channels[0].id, channels[0].slug, channels[0].title], [5001, 'moodboard', 'moodboard'], 'seeded from the picker');
  }

  /* Back-tagging: the picked channel is tagged so that the next run finds it without being picked again */
  {
    const tag = { pinterest_board_id: '7002', pinterest_slug: 'secret' };
    const plan = T.buildPlan(pinterest, { ...pinOptions, selected: ['7002'], destinations: { 7002: pick(5001, 'moodboard', 'moodboard') } });
    const puts = (calls) => calls.filter((c) => c.startsWith('PUT /channels/'));

    /* tagged once, other tools' metadata kept; a later run with a lost journal finds it by the tag */
    {
      const { S, fetchImpl } = mockArena({ fail500Once: false });
      addChannel(S, { id: 5001, slug: 'moodboard', title: 'moodboard', metadata: { other_tool: 'keep me' } });
      const spy = spyOn(fetchImpl);
      await T.runImport({ plan, client: client(spy.fetchImpl), journal: T.emptyJournal(), me });
      assert.deepEqual(S.channels.get(5001).metadata, { other_tool: 'keep me', ...tag }, 'merged, not replaced');
      assert.deepEqual(puts(spy.calls), ['PUT /channels/5001']);

      spy.calls.length = 0;
      const again = await T.runImport({ plan, client: client(spy.fetchImpl), journal: T.emptyJournal(), me });
      assert.deepEqual([again.counts.channelsCreated, again.counts.created, again.counts.channelsReused], [0, 0, 1], 'found through the tag');
      assert.ok(again.counts.skipped > 0);
      assert.ok(!spy.calls.includes('POST /channels') && !spy.calls.includes('GET /channels/5001') && !puts(spy.calls).length, 'no pick, no second tag');
      assert.equal(S.channels.get(5001).items.length, 12);
    }

    /* already tagged for this collection: nothing to send */
    {
      const { S, fetchImpl } = mockArena({ fail500Once: false });
      addChannel(S, { id: 5001, slug: 'moodboard', title: 'moodboard', metadata: tag });
      const spy = spyOn(fetchImpl);
      await T.runImport({ plan, client: client(spy.fetchImpl), journal: T.emptyJournal(), me });
      assert.equal(puts(spy.calls).length, 0);
    }

    /* tagged for another collection: left alone, said in the log, blocks still added */
    {
      const { S, fetchImpl } = mockArena({ fail500Once: false });
      const other = { pinterest_board_id: '1234', pinterest_slug: 'elsewhere' };
      addChannel(S, { id: 5001, slug: 'moodboard', title: 'moodboard', metadata: other });
      const spy = spyOn(fetchImpl);
      const logs = [];
      const r = await T.runImport({ plan, client: client(spy.fetchImpl), journal: T.emptyJournal(), me, emit: (e) => e.type === 'log' && logs.push(e) });
      assert.equal(puts(spy.calls).length, 0);
      assert.deepEqual(S.channels.get(5001).metadata, other);
      assert.ok(logs.some((l) => l.level === 'info' && /another collection/.test(l.message)));
      assert.equal(r.failures.length, 0);
      assert.equal(S.channels.get(5001).items.length, 12);
    }

    /* Are.na refuses the tag: a warning, and the transfer carries on */
    {
      const { S, fetchImpl } = mockArena({ fail500Once: false });
      addChannel(S, { id: 5001, slug: 'moodboard', title: 'moodboard' });
      const refusing = async (url, init) =>
        init.method === 'PUT' && /\/channels\/\d+$/.test(url)
          ? { status: 403, ok: false, headers: new Headers(), text: async () => '{}' }
          : fetchImpl(url, init);
      const logs = [];
      const r = await T.runImport({ plan, client: client(refusing), journal: T.emptyJournal(), me, emit: (e) => e.type === 'log' && logs.push(e) });
      assert.equal(r.failures.length, 0);
      assert.ok(logs.some((l) => l.level === 'warn' && /tag/.test(l.message)));
      assert.equal(S.channels.get(5001).items.length, 12, 'the transfer carried on');
    }

    /* simulation writes nothing, tags included */
    {
      const dry = new T.DryRunClient();
      const seen = [];
      const request = dry.request.bind(dry);
      dry.request = (method, path, opts) => (seen.push(`${method} ${path}`), request(method, path, opts));
      await T.runImport({ plan, client: dry, journal: T.emptyJournal(), me: null });
      assert.equal(puts(seen).length, 0);
    }
  }

  console.log('✓ destinations');
}

/* Batch mode: new channels forced private, blocks created via POST /blocks/batch, same end state. */
{
  const plan = T.buildPlan(cosmos, { selected: ['1'], visibility: 'private' });
  const { S, fetchImpl } = mockArena({ fail500Once: false });
  const calls = [];
  const spied = (url, init) => (calls.push(`${init.method} ${new URL(url).pathname.replace('/v3', '').split('?')[0]}`), fetchImpl(url, init));
  const r = await T.runImport({ plan, client: client(spied), journal: T.emptyJournal(), me, batchMode: true });
  assert.equal(r.failures.length, 0, 'batch run has no failures');
  const batchPosts = calls.filter((c) => c === 'POST /blocks/batch').length;
  const singlePosts = calls.filter((c) => c === 'POST /blocks').length;
  assert.ok(batchPosts >= 1, 'at least one batch POST was made');
  assert.ok(singlePosts <= 2, `single-block POSTs come only from arena-ref fallbacks (got ${singlePosts})`);
  const createdChannel = [...S.channels.values()].find((c) => c.title === 'Type');
  assert.equal(createdChannel.visibility, 'private', 'batch mode forced the new channel private');
  assert.ok(createdChannel.items.length > 0, 'blocks landed in the channel');
  console.log('✓ batch mode (happy path)', r.counts);
}

/* Batch mode without Premium: 403 on first batch disables batching; main loop finishes with single-POSTs. */
{
  const plan = T.buildPlan(cosmos, { selected: ['1'], visibility: 'private' });
  const { S, fetchImpl } = mockArena({ fail500Once: false, noBatch: true });
  const calls = [];
  const spied = (url, init) => (calls.push(`${init.method} ${new URL(url).pathname.replace('/v3', '').split('?')[0]}`), fetchImpl(url, init));
  const logs = [];
  const r = await T.runImport({ plan, client: client(spied), journal: T.emptyJournal(), me, batchMode: true, emit: (e) => e.type === 'log' && logs.push(e) });
  assert.equal(r.failures.length, 0, 'fallback import has no failures');
  const batchPosts = calls.filter((c) => c === 'POST /blocks/batch').length;
  const singlePosts = calls.filter((c) => c === 'POST /blocks').length;
  assert.equal(batchPosts, 1, 'only one batch attempt before fallback');
  assert.ok(singlePosts > 0, 'main loop took over with single POSTs');
  assert.ok(logs.some((l) => l.level === 'warn' && /batch mode disabled/i.test(l.message)), 'fallback is surfaced in the log');
  console.log('✓ batch mode falls back on 403', r.counts);
}

console.log('ALL TESTS PASS');
