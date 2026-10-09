// Tests for the export scripts (picking, single board or collection, delivery), against the
// simulated Pinterest, Cosmos and Are.na of the demo. Run: node tests/export.test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = (path) => new URL(path, import.meta.url).pathname;
const { exportKit } = require(here('../export-kit.js'));
const { pinterestExport } = require(here('../pinterest-export.js'));
const { cosmosExport } = require(here('../cosmos-export.js'));
const T = require(here('../arena.js'));
const M = require(here('../demo/mock-sources.js'));

/* A panel without a screen: records what it shows and picks what the test says. */
function headless(choose = () => [], extra = false) {
  const ui = { picks: 0, statuses: [], doneText: null };
  ui.status = (text) => ui.statuses.push(text);
  ui.pick = async ({ items }) => {
    ui.picks++;
    ui.offered = items.map((i) => i.name);
    return { ids: choose(items).map((i) => i.id), extra };
  };
  ui.done = (text) => (ui.doneText = text);
  ui.error = (text) => {
    throw new Error(text);
  };
  return ui;
}

const kit = exportKit();
const pinterestEnv = (path, ui, more = {}) => ({ origin: 'https://www.pinterest.com', path, fetch: M.pinterestApi(undefined, { latency: 0 }), ui, save: () => {}, ...more });
const cosmosEnv = (path, ui, more = {}) => ({ anonymous: true, path, fetch: M.cosmosApi(undefined, { latency: 0 }), ui, save: () => {}, ...more });

/* Pinterest, on a profile: the picker lists every board, secret ones too, and only ticked ones are read. */
{
  const ui = headless((items) => items.filter((i) => ['Ceramics', 'Colour studies'].includes(i.name)));
  const data = await pinterestExport(pinterestEnv('/demo-studio/', ui), kit);
  assert.equal(ui.picks, 1);
  assert.deepEqual(ui.offered, ['Brutalist houses', 'Type specimens', 'Ceramics', 'Colour studies', 'Studio ideas']);
  assert.deepEqual(data.collections.map((c) => [c.name, c.parentId ? 'section' : 'board']), [
    ['Ceramics', 'board'],
    ['Bowls', 'section'],
    ['Vases', 'section'],
    ['Colour studies', 'board'],
  ]);
  assert.equal(data.collections.find((c) => c.name === 'Colour studies').isPrivate, true);
  assert.equal(data.collections[0].elementIds.length, 3 + 4 + 3, 'a board lists the pins of its sections too');
  assert.equal(Object.keys(data.elements).length, 15);
  console.log('✓ Pinterest profile: picker, secret board, sections');
}

/* Pinterest, on a board's page: that board only, no picker; carousels and videos kept. */
{
  const ui = headless();
  const data = await pinterestExport(pinterestEnv('/demo-studio/type-specimens/', ui), kit);
  assert.equal(ui.picks, 0, 'no picker on a board page');
  assert.deepEqual(data.collections.map((c) => c.name), ['Type specimens']);
  const carousel = Object.values(data.elements).find((e) => e.media.length > 1);
  assert.equal(carousel.media.length, 3);
  const video = (await pinterestExport(pinterestEnv('/demo-studio/studio-ideas/', headless()), kit)).elements;
  assert.ok(Object.values(video).some((e) => e.media[0].type === 'Video'));
  console.log('✓ Pinterest board page: just that board');
}

/* Pinterest, an address that isn't a board: falls back to the picker. */
{
  const ui = headless((items) => items.slice(0, 1));
  const data = await pinterestExport(pinterestEnv('/demo-studio/_saved/', ui), kit);
  assert.equal(ui.picks, 1);
  assert.equal(data.collections.length, 1);
  const ui2 = headless((items) => items.slice(0, 1));
  await pinterestExport(pinterestEnv('/demo-studio/no-such-board/', ui2), kit);
  assert.equal(ui2.picks, 1, 'unknown board → picker');
  console.log('✓ Pinterest other pages: picker');
}

/* Delivery: handed to the tool when the handshake works, and the panel says so. */
{
  let delivered = null;
  const ui = headless();
  const env = pinterestEnv('/demo-studio/ceramics/', ui, { save: undefined, deliver: async (data, filename) => ((delivered = { data, filename }), 'sent') });
  await pinterestExport(env, kit);
  assert.match(delivered.filename, /^pinterest-export-demo-studio-\d{4}-\d{2}-\d{2}\.json$/);
  assert.match(ui.doneText, /^Sent to To Are\.na/);
  console.log('✓ delivery to the tool');
}

/* Cosmos, on a collection's page: that collection and its sub-collections, signed out. */
{
  const ui = headless();
  const data = await cosmosExport(cosmosEnv('/demo/graphic-design', ui), kit);
  assert.equal(ui.picks, 0);
  assert.deepEqual(data.collections.map((c) => [c.name, c.parentId ? 'sub' : 'top']), [
    ['Graphic design', 'top'],
    ['Posters', 'sub'],
  ]);
  assert.equal(data.library, null);
  const sub = await cosmosExport(cosmosEnv('/demo/graphic-design/posters', headless()), kit);
  assert.deepEqual(sub.collections.map((c) => c.name), ['Posters']);
  assert.ok(Object.values(data.elements).some((e) => e.kind === 'website'));
  console.log('✓ Cosmos collection page: collection and sub-collections');
}

/* Cosmos elsewhere: picker of your collections, the library only when asked. */
{
  const ui = headless((items) => items.filter((i) => i.name === 'Lighting'), true);
  const data = await cosmosExport(cosmosEnv('/', ui, { me: { id: 501, username: 'demo', fullName: 'Demo Studio' } }), kit);
  assert.equal(ui.picks, 1);
  assert.deepEqual(ui.offered, ['Lighting', 'Graphic design', 'Posters', 'Interiors']);
  assert.deepEqual(data.collections.map((c) => c.name), ['Lighting']);
  assert.ok(data.library.elementIds.length > data.collections[0].elementIds.length, 'library holds unsorted items');
  assert.ok(Object.values(data.elements).some((e) => e.kind === 'text'));
  assert.ok(Object.values(data.elements).some((e) => e.media.length === 3), 'carousel expanded');
  const none = await cosmosExport(cosmosEnv('/', headless((items) => items.slice(0, 1)), { me: { id: 501, username: 'demo' } }), kit);
  assert.equal(none.library, null, 'no library unless ticked');
  console.log('✓ Cosmos picker and library option');
}

/* End to end: an export, then a transfer into the simulated Are.na. */
for (const [label, source] of [
  ['Pinterest', () => pinterestExport(pinterestEnv('/demo-studio/', headless((items) => items)), kit)],
  ['Cosmos', () => cosmosExport(cosmosEnv('/', headless((items) => items, true), { me: { id: 501, username: 'demo' } }), kit)],
]) {
  const data = T.normalizeExport(await source());
  const arena = M.arenaApi({ latency: 0, pauseSeconds: 0.05 });
  const client = new T.ArenaClient('demo-token', { fetchImpl: arena.fetchImpl, writeGap: 0 });
  assert.equal(await T.checkWriteAccess(client), true);
  assert.equal(await T.checkWriteAccess(new T.ArenaClient('read-only', { fetchImpl: arena.fetchImpl, writeGap: 0 })), false);
  const plan = T.buildPlan(data, { selected: data.collections.map((c) => c.id), includeLibrary: !!data.library });
  const r = await T.runImport({ plan, client, journal: T.emptyJournal(), me: { id: 42 } });
  assert.equal(r.failures.length, 0);
  assert.ok(r.counts.linked >= 1, 'an Are.na original is connected');
  const originals = [...arena.state.channels.values()].flatMap((c) => arena.contents(c.id)).filter((x) => x.type === 'Original');
  assert.ok(originals.length >= 1);
  console.log(`✓ ${label} end to end`, r.counts);
}

console.log('ALL EXPORT TESTS PASS');
