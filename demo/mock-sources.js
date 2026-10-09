/*
 * To Are.na · simulated sources and Are.na, for the demo page and the tests.
 *
 * - placeholder(key): a flat illustration (SVG data URL) standing in for an image
 * - pinterestApi() / cosmosApi(): fetch functions answering like Pinterest's and Cosmos's internal APIs
 * - arenaApi(): an in-memory Are.na that answers like its API v3
 * Nothing here touches the network.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ToArenaMocks = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEMO_HOST = 'https://demo.invalid/';
  const PALETTE = [
    ['#e8e3da', '#3d3a35'],
    ['#dde5e0', '#2e4b42'],
    ['#ece0d4', '#8b4a2b'],
    ['#e0e2ea', '#2f3561'],
    ['#efe8d6', '#7b6a26'],
    ['#e7dfe6', '#5b3a56'],
    ['#d9e1e8', '#24435c'],
    ['#ebe5e0', '#6b2f2f'],
  ];

  function hash(text) {
    let h = 2166136261;
    for (const c of String(text)) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    /* Final mix, so that keys differing by one digit look different. */
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  const SIZES = [
    [400, 500],
    [400, 400],
    [400, 560],
    [500, 400],
  ];

  /* A flat shape on a muted ground: stands in for a picture without showing anyone's work. */
  function placeholder(key) {
    const h = hash(key);
    const [bg, fg] = PALETTE[h % PALETTE.length];
    const [w, ht] = SIZES[(h >>> 4) % SIZES.length];
    const cx = w / 2;
    const cy = ht / 2;
    const r = Math.round(Math.min(w, ht) * 0.27);
    const shapes = [
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fg}"/>`,
      `<path d="M${cx - r} ${cy + r * 1.3}V${cy}a${r} ${r} 0 0 1 ${2 * r} 0V${cy + r * 1.3}Z" fill="${fg}"/>`,
      `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" fill="${fg}"/>`,
      [0, 1, 2, 3, 4].map((i) => `<rect x="${cx - r * 1.3}" y="${cy - r * 1.2 + i * r * 0.55}" width="${r * 2.6}" height="${r * 0.22}" fill="${fg}"/>`).join(''),
      `<circle cx="${cx - r * 0.45}" cy="${cy}" r="${r * 0.8}" fill="${fg}"/><circle cx="${cx + r * 0.45}" cy="${cy}" r="${r * 0.8}" fill="${fg}" fill-opacity=".45"/>`,
    ];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}"><rect width="${w}" height="${ht}" fill="${bg}"/>${shapes[(h >>> 7) % shapes.length]}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  const image = (key) => `${DEMO_HOST}img/${key}.jpg`;
  const isDemoUrl = (url) => typeof url === 'string' && url.startsWith(DEMO_HOST);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  /* Originals that already live on the simulated Are.na. */
  const ARENA_ORIGINALS = { 9000001: 'Concrete stair, saved on Are.na', 9000002: 'Lamp study, saved on Are.na' };

  /* ───────────── Pinterest ───────────── */

  function pinterestData() {
    const username = 'demo-studio';
    const owner = { id: '7000', username };
    const boards = [];
    let pinId = 880000;
    const pinsOf = (titles, extra = () => ({})) =>
      titles.map((title, i) => {
        const id = String(++pinId);
        const pin = {
          type: 'pin',
          id,
          title,
          grid_title: title,
          description: i % 3 === 0 ? `${title}. Saved for the studio’s research.` : ' ',
          link: i % 2 ? `https://www.example.com/journal/${id}` : null,
          alt_text: `${title}`,
          images: { orig: { url: image(`p${id}`), width: 1000, height: 1250 } },
          ...extra(i, id),
        };
        return pin;
      });
    const board = (name, slug, titles, { secret = false, sections = [], extra } = {}) => {
      const pins = pinsOf(titles, extra);
      const sectionList = sections.map((s, i) => ({
        id: `${slug}-s${i + 1}`,
        title: s.title,
        slug: s.slug,
        pins: pinsOf(s.titles),
      }));
      boards.push({ id: String(300 + boards.length), name, slug, secret, pins, sections: sectionList });
    };
    board('Brutalist houses', 'brutalist-houses', ['Concrete house, hillside', 'Board-marked wall', 'Courtyard in raw concrete', 'Cantilevered terrace', 'Stair in a light well', 'Monolithic chapel', 'House with a pool', 'Pilotis and garden'], {
      extra: (i) => (i === 4 ? { link: 'https://www.are.na/block/9000001' } : {}),
    });
    board('Type specimens', 'type-specimens', ['Grotesk specimen', 'Stencil alphabet', 'Display serif sheet', 'Wood type proof', 'Mono weights', 'Script trial'], {
      extra: (i, id) =>
        i === 1
          ? { carousel_data: { carousel_slots: [0, 1, 2].map((k) => ({ images: { '736x': { url: image(`p${id}-${k}`), width: 736, height: 920 } } })) } }
          : {},
    });
    board('Ceramics', 'ceramics', ['Studio shelf', 'Glaze tests', 'Kiln opening'], {
      sections: [
        { title: 'Bowls', slug: 'bowls', titles: ['Ash-glazed bowl', 'Stacked bowls', 'Footed bowl', 'Rice bowl'] },
        { title: 'Vases', slug: 'vases', titles: ['Bottle vase', 'Ribbed vase', 'Moon jar'] },
      ],
    });
    board('Colour studies', 'colour-studies', ['Ochre and blue', 'Three greens', 'Warm greys', 'Red on pink', 'Faded poster'], { secret: true });
    board('Studio ideas', 'studio-ideas', ['Pinboard wall', 'Flat files', 'Work table', 'Window light', 'Plan chest'], {
      extra: (i, id) => (i === 2 ? { videos: { video_list: { V_720P: { url: `${DEMO_HOST}video/${id}.mp4`, width: 720, height: 900 } } } } : {}),
    });
    return { username, owner, boards };
  }

  function rawBoard(b, owner) {
    const pinCount = b.pins.length + b.sections.reduce((n, s) => n + s.pins.length, 0);
    return {
      type: 'board',
      id: b.id,
      name: b.name,
      url: `/${owner.username}/${b.slug}/`,
      privacy: b.secret ? 'secret' : 'public',
      pin_count: pinCount,
      section_count: b.sections.length,
      owner,
      description: '',
      image_cover_url: b.pins[0]?.images.orig.url || null,
    };
  }

  /* Answers like pinterest.com/resource/…Resource/get/ for the demo profile. */
  function pinterestApi(data = pinterestData(), { latency = 90 } = {}) {
    const PAGE = 25;
    const page = (items, bookmarks) => {
      const start = Number(bookmarks?.[0] || 0);
      const next = start + PAGE < items.length ? [String(start + PAGE)] : ['-end-'];
      return json({ resource_response: { status: 'success', data: items.slice(start, start + PAGE) }, resource: { options: { bookmarks: next } } });
    };
    return async (input) => {
      const url = new URL(String(input));
      const name = url.pathname.match(/^\/resource\/(\w+)Resource\/get\/$/)?.[1];
      const options = JSON.parse(url.searchParams.get('data') || '{}').options || {};
      await delay(latency);
      const boardById = (id) => data.boards.find((b) => b.id === String(id));
      switch (name) {
        case 'Boards':
          return page(options.username === data.username ? data.boards.map((b) => rawBoard(b, data.owner)) : [], options.bookmarks);
        case 'Board': {
          const b = options.username === data.username && data.boards.find((x) => x.slug === options.slug);
          return b
            ? json({ resource_response: { status: 'success', data: rawBoard(b, data.owner) }, resource: { options: {} } })
            : json({ resource_response: { status: 'failure', message: 'Board not found' } }, 404);
        }
        case 'BoardFeed': {
          const b = boardById(options.board_id);
          return page(b ? [...b.pins, ...b.sections.flatMap((s) => s.pins)] : [], options.bookmarks);
        }
        case 'BoardSections': {
          const b = boardById(options.board_id);
          return page(
            (b?.sections || []).map((s) => ({ id: s.id, title: s.title, slug: s.slug, pin_count: s.pins.length, preview_pins: s.pins.slice(0, 1) })),
            options.bookmarks
          );
        }
        case 'BoardSectionPins': {
          const s = data.boards.flatMap((b) => b.sections).find((x) => x.id === String(options.section_id));
          return page(s ? s.pins : [], options.bookmarks);
        }
        default:
          return json({ resource_response: { status: 'failure', message: 'Unknown resource' } }, 404);
      }
    };
  }

  /* ───────────── Cosmos ───────────── */

  function cosmosData() {
    const me = { id: 501, username: 'demo', fullName: 'Demo Studio' };
    let elementId = 4400000;
    const author = (i) => (i % 2 ? { username: `maker${i}`, fullName: `Maker ${i}`, profileUrl: `https://www.example.com/@maker${i}` } : null);
    const elementsOf = (captions, extra = () => ({})) =>
      captions.map((caption, i) => {
        const id = ++elementId;
        const media = { __typename: 'StaticImage', url: image(`c${id}`), width: 1000, height: 1250 };
        return {
          __typename: 'MediaElementTile',
          id,
          createdAt: '2025-03-01T10:00:00Z',
          shareUrl: `https://www.cosmos.so/e/${id}`,
          generatedCaption: { text: caption },
          source: { url: `https://www.example.com/archive/${id}`, author: author(i) },
          hasMoreMedia: false,
          media,
          multipleMedia: [],
          ...extra(i, id, media),
        };
      });
    const clusters = [];
    const cluster = (name, slug, captions, { isPrivate = false, parent = null, extra } = {}) => {
      const c = { id: 900 + clusters.length, name, slug, isPrivate, parent, elements: elementsOf(captions, extra) };
      clusters.push(c);
      return c;
    };
    cluster('Lighting', 'lighting', [
      'Pendant lamp in spun aluminium, 1969. Photo by A. Studio.',
      'Paper floor lamp in a tatami room.',
      'Brass wall sconce, prototype.',
      'Glass globe lights in a stairwell.',
      'Desk lamp with a folded steel shade.',
      'Lamp study, saved from Are.na.',
    ], {
      extra: (i, id, media) =>
        i === 2
          ? { multipleMedia: [media, { __typename: 'StaticImage', url: image(`c${id}-2`), width: 1000, height: 1000 }, { __typename: 'StaticImage', url: image(`c${id}-3`), width: 1000, height: 1250 }] }
          : i === 5
            ? { source: { url: 'https://www.are.na/block/9000002', author: null } }
            : {},
    });
    const graphic = cluster('Graphic design', 'graphic-design', ['Exhibition identity in two colours.', 'Annual report cover.', 'Signage for a library.', 'Book spine studies.'], {
      extra: (i, id) =>
        i === 3
          ? { __typename: 'WebsiteElementTile', websiteTitle: 'A small type foundry', websiteDescription: 'Typefaces and essays.', source: { url: `https://www.example.org/foundry`, author: null }, multipleMedia: undefined }
          : {},
    });
    cluster('Posters', 'posters', ['Concert poster, risograph.', 'Film festival poster, 1972.', 'Lecture series poster.'], { parent: graphic });
    cluster('Interiors', 'interiors', ['Kitchen in pale oak.', 'Reading corner with a daybed.', 'Hallway with a terrazzo floor.', 'Bathroom in green tiles.'], { isPrivate: true });
    const unsorted = elementsOf(['A note on proportions.', 'Chair in bent plywood.']);
    unsorted[0] = { __typename: 'TextElementTile', id: unsorted[0].id, createdAt: '2025-03-01T10:00:00Z', shareUrl: unsorted[0].shareUrl, generatedCaption: { text: '' }, source: null, text: 'Proportions: start from the window, not the wall.' };
    return { me, clusters, unsorted };
  }

  function rawCluster(c, me) {
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: '',
      isPrivate: c.isPrivate,
      numberOfElements: c.elements.length,
      parentClusterId: c.parent ? c.parent.id : null,
      isPublicElementsCluster: false,
      coverImageUrl: c.elements[0]?.media?.url || null,
      owner: { id: me.id, username: me.username },
    };
  }

  /* Answers like api.cosmos.so/graphql (and the session endpoint) for the demo account. */
  function cosmosApi(data = cosmosData(), { latency = 80 } = {}) {
    const gqlError = (message, code) => json({ errors: [{ message, extensions: { code } }], data: null });
    return async (input, init = {}) => {
      const url = String(input);
      await delay(latency);
      if (url.endsWith('/api/refresh-token')) return json({ accessToken: 'demo-session' });
      const { operationName: op, variables: v = {} } = JSON.parse(init.body || '{}');
      const full = (c) => ({ ...rawCluster(c, data.me), subClusters: { items: data.clusters.filter((s) => s.parent === c).map((s) => rawCluster(s, data.me)) } });
      const find = (id) => data.clusters.find((c) => c.id === Number(id));
      const all = [...data.clusters.flatMap((c) => c.elements), ...data.unsorted];
      switch (op) {
        case 'Me':
          return json({ data: { me: data.me } });
        case 'UserClusters': {
          const items = data.clusters.filter((c) => !c.parent).map(full);
          return json({ data: { userClusters: { items, meta: { nextPageCursor: null, count: items.length } } } });
        }
        case 'ClusterBySlug': {
          const c = v.input?.ownerUsername === data.me.username && data.clusters.find((x) => x.slug === v.input.slug && !x.parent);
          if (!c) return gqlError('Collection not found', 'NOT_FOUND');
          const sub = v.withSub ? data.clusters.find((s) => s.parent === c && s.slug === v.sub) : null;
          return json({ data: { cluster: { ...full(c), ...(v.withSub && { subCluster: sub ? rawCluster(sub, data.me) : null }) } } });
        }
        case 'ClusterElements': {
          const c = find(v.clusterId);
          const items = (c?.elements || []).map((element) => ({ element }));
          return json({ data: { clusterConnections: { items, meta: { nextPageCursor: null, count: items.length } } } });
        }
        case 'LibraryElements':
          return json({ data: { allElementsV2: { items: all, meta: { nextPageCursor: null, count: all.length } } } });
        case 'ElementMedia': {
          const e = all.find((x) => x.id === Number(v.elementId));
          return json({ data: { elementView: { media: e?.multipleMedia?.length ? e.multipleMedia : [e?.media].filter(Boolean) } } });
        }
        default:
          return gqlError(`Unknown operation ${op}`, 'BAD_REQUEST');
      }
    };
  }

  /* ───────────── Are.na ───────────── */

  /*
   * An in-memory Are.na: channels, blocks and connections, with positions (1 = bottom, highest =
   * top), a read-only token, and one rate-limit pause so the countdown can be seen.
   */
  function arenaApi({ latency = 35, pauseAfterWrites = 18, pauseSeconds = 3, tier = 'premium' } = {}) {
    const S = { channels: new Map(), blocks: new Map(), nextId: 1000, nextConn: 1, writes: 0, paused: false };
    for (const [id, title] of Object.entries(ARENA_ORIGINALS)) S.blocks.set(Number(id), { id: Number(id), external: true, kind: 'Image', title, value: image(`arena${id}`) });

    const page = (arr, q) => {
      const per = +q.get('per') || 24;
      const p = +q.get('page') || 1;
      return { data: arr.slice((p - 1) * per, p * per), meta: { has_more_pages: p * per < arr.length } };
    };
    const findChannel = (idOrSlug) => S.channels.get(+idOrSlug) || [...S.channels.values()].find((c) => c.slug === idOrSlug);
    const connect = (c, item, metadata) => c.items.push({ ...item, connId: S.nextConn++, metadata: metadata || null });
    const view = (it, index) => {
      const connection = { id: it.connId, position: index + 1, metadata: it.metadata };
      if (it.type === 'Channel') {
        const ch = S.channels.get(it.id);
        return { id: ch.id, type: 'Channel', title: ch.title, metadata: ch.metadata, connection };
      }
      const b = S.blocks.get(it.id);
      return { id: b.id, type: b.kind, title: b.title, metadata: b.external ? null : b.metadata, source: b.sourceUrl ? { url: b.sourceUrl } : null, connection };
    };

    const fetchImpl = async (url, { method = 'GET', body, headers = {} } = {}) => {
      await delay(latency);
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname.replace('/v3', ''));
      const b = body ? JSON.parse(body) : null;
      const auth = headers.Authorization || '';
      if (!auth.startsWith('Bearer ') || auth.length < 9) return json({ error: 'Unauthorized', code: 401 }, 401);
      if (method !== 'GET') {
        if (auth === 'Bearer read-only') return json({ error: 'Forbidden', code: 403 }, 403);
        S.writes++;
        if (!S.paused && S.writes === pauseAfterWrites) {
          S.paused = true;
          return json({ error: 'Too Many Requests' }, 429, { 'retry-after': String(pauseSeconds) });
        }
      }
      let m;
      if (method === 'GET' && path === '/me') return json({ id: 42, slug: 'you', name: 'You (demo)', tier, avatar: null });
      if (method === 'GET' && (m = path.match(/^\/users\/(\d+)\/contents$/))) {
        const mine = [...S.channels.values()].map((c) => ({ id: c.id, type: 'Channel', slug: c.slug, title: c.title, metadata: c.metadata, state: 'available' }));
        return json(page(mine, u.searchParams));
      }
      if (method === 'GET' && (m = path.match(/^\/channels\/([^/]+)$/))) {
        const c = findChannel(m[1]);
        return c ? json({ id: c.id, slug: c.slug, title: c.title, state: 'available' }) : json({ error: 'Not Found' }, 404);
      }
      if (method === 'GET' && (m = path.match(/^\/channels\/(\d+)\/contents$/))) {
        const c = S.channels.get(+m[1]);
        return c ? json(page(c.items.map(view).reverse(), u.searchParams)) : json({ error: 'Not Found' }, 404);
      }
      if (method === 'POST' && path === '/channels') {
        const id = S.nextId++;
        const slug = `${String(b.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${id}`;
        S.channels.set(id, { id, slug, title: b.title, visibility: b.visibility, metadata: b.metadata, items: [] });
        return json({ id, slug, title: b.title, owner: { slug: 'you' } }, 201);
      }
      if (method === 'POST' && path === '/blocks') {
        const c = S.channels.get(b.channel_ids?.[0]);
        if (!c) return json({ error: 'Not Found' }, 404);
        const isUrl = /^https?:\/\//.test(b.value);
        const kind = !isUrl ? 'Text' : isDemoUrl(b.value) ? (/\.mp4$/.test(b.value) ? 'Attachment' : 'Image') : 'Link';
        const id = S.nextId++;
        S.blocks.set(id, { id, kind, title: b.title || '', value: b.value, cover: b.cover_url || null, description: b.description || '', metadata: b.metadata, sourceUrl: kind === 'Link' ? b.value : b.original_source_url || null });
        connect(c, { type: 'Block', id });
        return json({ id, type: 'PendingBlock' }, 201);
      }
      if (method === 'POST' && path === '/connections') {
        const target = (b.channels || (b.channel_ids || []).map((id) => ({ id })))[0];
        const c = target && findChannel(target.id);
        if (!c) return json({ error: 'Not Found' }, 404);
        const exists = b.connectable_type === 'Block' ? S.blocks.has(b.connectable_id) : S.channels.has(b.connectable_id);
        if (!exists) return json({ error: 'Not Found' }, 404);
        if (c.items.some((it) => it.type === b.connectable_type && it.id === b.connectable_id)) return json({ error: 'Already connected' }, 422);
        connect(c, { type: b.connectable_type, id: b.connectable_id }, target.metadata);
        return json([{ id: S.nextConn }], 201);
      }
      if (method === 'DELETE' && (m = path.match(/^\/connections\/(\d+)$/))) {
        for (const c of S.channels.values()) {
          const i = c.items.findIndex((it) => it.connId === +m[1]);
          if (i >= 0) {
            c.items.splice(i, 1);
            return new Response(null, { status: 204 });
          }
        }
        return json({ error: 'Not Found' }, 404);
      }
      return json({ error: 'Not handled in the demo' }, 400);
    };

    /* What a channel shows, top to bottom. */
    const contents = (channelId) =>
      [...(S.channels.get(channelId)?.items || [])].reverse().map((it) => {
        if (it.type === 'Channel') return { type: 'Channel', channel: S.channels.get(it.id) };
        const block = S.blocks.get(it.id);
        return { type: block.external ? 'Original' : block.kind, block };
      });

    return { state: S, fetchImpl, contents };
  }

  return { DEMO_HOST, placeholder, isDemoUrl, pinterestData, pinterestApi, cosmosData, cosmosApi, arenaApi, ARENA_ORIGINALS };
});
