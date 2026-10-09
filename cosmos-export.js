/*
 * To Are.na · Cosmos exporter
 *
 * Runs on https://www.cosmos.so (bookmarklet or browser console). Read-only: nothing changes on
 * Cosmos.
 *   - On a collection's page, it takes that collection with its sub-collections (signed in or,
 *     for a public collection, not).
 *   - Anywhere else, it lists your collections (signed in) and lets you pick.
 * Then it hands the items to the To Are.na tab that opened Cosmos, or downloads a JSON file.
 *
 * `env` lets it run elsewhere (tests, demo): { anonymous, path, me, fetch, toolOrigin, ui, mount,
 * deliver, save }.
 */
async function cosmosExport(env = {}, kit = exportKit()) {
  const API = 'https://api.cosmos.so/graphql';
  const PAGE_SIZE = 500;
  const PATH = env.path ?? (typeof location !== 'undefined' ? location.pathname : '/');
  /* Site pages that are not a user, and profile pages that are not a collection. */
  const NOT_USER = new Set('e,search,settings,explore,home,login,signup,brand,api,about,discover,shop,messages,notifications,organize,pricing,legal'.split(','));
  const NOT_COLLECTION = new Set('collections,elements,followers,following,likes,organize,search'.split(','));

  const MEDIA = `fragment M on Media {
    __typename mediaId url width height
    ... on AnimatedImage { video { url } }
    ... on Video { thumbnail { url } }
  }`;
  const ELEMENT = `fragment E on ElementTile {
    __typename id createdAt shareUrl
    generatedCaption { text }
    source { url author { username fullName profileUrl } }
    ... on MediaElementTile { hasMoreMedia media { ...M } multipleMedia { ...M } }
    ... on WebsiteElementTile { media { ...M } websiteTitle: title websiteDescription: description }
    ... on ProductElementTile { media { ...M } productTitle: name productBrand: brand productDescription: description }
    ... on TextElementTile { text }
  }`;
  const CLUSTER = `fragment C on Cluster {
    id name slug description isPrivate numberOfElements parentClusterId isPublicElementsCluster coverImageUrl
    owner { id username }
  }`;
  const Q = {
    Me: `query Me { me { id username fullName } }`,
    UserClusters: `query UserClusters($userId: UserId!, $pageCursor: String) {
      userClusters(userId: $userId, meta: { pageSize: 50, pageCursor: $pageCursor }, order: PINNING_THEN_RECENT_CONNECTION) {
        items { ...C subClusters { items { ...C } } }
        meta { nextPageCursor count }
      }
    } ${CLUSTER}`,
    ClusterBySlug: `query ClusterBySlug($input: ClusterGetInput!, $sub: String, $withSub: Boolean!) {
      cluster(input: $input) {
        ...C
        subClusters { items { ...C } }
        subCluster(slug: $sub) @include(if: $withSub) { ...C }
      }
    } ${CLUSTER}`,
    ClusterElements: `query ClusterElements($clusterId: ClusterId, $pageCursor: String, $pageSize: Int) {
      clusterConnections(clusterId: $clusterId, meta: { pageSize: $pageSize, pageCursor: $pageCursor }) {
        items { element { ...E } }
        meta { nextPageCursor count }
      }
    } ${ELEMENT} ${MEDIA}`,
    LibraryElements: `query LibraryElements($userId: UserId!, $pageCursor: String, $pageSize: Int) {
      allElementsV2(userId: $userId, meta: { pageSize: $pageSize, pageCursor: $pageCursor }) {
        items { ...E }
        meta { nextPageCursor count }
      }
    } ${ELEMENT} ${MEDIA}`,
    ElementMedia: `query ElementMedia($elementId: ElementId!) {
      elementView(elementId: $elementId) { ... on MultiMediaElementView { media { ...M } } }
    } ${MEDIA}`,
  };

  const { sleep } = kit;
  const doFetch = env.fetch || ((...args) => fetch(...args));
  const ui = env.ui || kit.createOverlay('Cosmos → Are.na', { mount: env.mount });
  let token = null;

  /* The site's own session endpoint hands out a short-lived access token: no password involved. */
  async function refreshToken() {
    try {
      const res = await doFetch('/api/refresh-token', {
        credentials: 'include',
        headers: { 'x-cosmos-refresh-trigger': 'to-arena-export' },
      });
      if (!res.ok) return null;
      return (await res.json()).accessToken || null;
    } catch {
      return null;
    }
  }

  async function gql(name, variables = {}, attempt = 0) {
    let res, body;
    try {
      res = await doFetch(`${API}?q=${name}`, {
        method: 'POST',
        credentials: env.anonymous ? 'omit' : 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-client-name': 'cosmos-web',
          ...(token && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ operationName: name, query: Q[name], variables }),
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      if (attempt < 4) return sleep(1000 * 2 ** attempt).then(() => gql(name, variables, attempt + 1));
      throw err;
    }
    const code = body?.errors?.[0]?.extensions?.code;
    if ((res.status === 429 || code === 'RATE_LIMIT') && attempt < 6) {
      ui.status(`Cosmos asks to slow down, retrying in ${2 ** attempt * 2} s`);
      await sleep(2000 * 2 ** attempt);
      return gql(name, variables, attempt + 1);
    }
    if ((res.status === 401 || code === 'AUTHENTICATION') && !env.anonymous && attempt === 0) {
      token = await refreshToken();
      if (token) return gql(name, variables, attempt + 1);
    }
    if (res.status >= 500 && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return gql(name, variables, attempt + 1);
    }
    if (!res.ok || !body?.data) {
      const err = new Error(`${name}: ${body?.errors?.[0]?.message || `HTTP ${res.status}`}`);
      err.code = code;
      throw err;
    }
    return body.data;
  }

  async function paginate(name, variables, pick, onPage) {
    const items = [];
    let pageCursor = null;
    do {
      const conn = pick(await gql(name, { ...variables, pageCursor }));
      items.push(...conn.items);
      onPage?.(items.length, conn.meta.count);
      pageCursor = conn.meta.nextPageCursor;
    } while (pageCursor);
    return items;
  }

  const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '').trim();

  function normMedia(m) {
    if (!m?.url && !m?.video?.url) return null;
    return {
      type: m.__typename,
      url: m.url || m.video.url,
      width: m.width ?? null,
      height: m.height ?? null,
      ...(m.video?.url && { videoUrl: m.video.url }),
      ...(m.thumbnail?.url && { thumbnailUrl: m.thumbnail.url }),
    };
  }

  function normMediaList(list) {
    const seen = new Set();
    return list.map(normMedia).filter((m) => m && !seen.has(m.url) && seen.add(m.url));
  }

  /* The cover shown on Cosmos always comes first (index 0). */
  function coverFirst(media, coverUrl) {
    const i = media.findIndex((m) => m.url === coverUrl);
    return i > 0 ? [media[i], ...media.slice(0, i), ...media.slice(i + 1)] : media;
  }

  function normElement(e) {
    const kind =
      { MediaElementTile: 'media', WebsiteElementTile: 'website', ProductElementTile: 'product', TextElementTile: 'text' }[
        e.__typename
      ] || 'other';
    const media = coverFirst(normMediaList(e.multipleMedia?.length ? e.multipleMedia : [e.media]), e.media?.url);
    const author = e.source?.author;
    return {
      id: String(e.id),
      kind,
      createdAt: e.createdAt,
      url: e.shareUrl,
      caption: stripTags(e.generatedCaption?.text),
      source: e.source?.url
        ? {
            url: e.source.url,
            author: author ? { name: author.fullName || author.username, username: author.username, url: author.profileUrl } : null,
          }
        : null,
      media,
      title: e.websiteTitle || e.productTitle || null,
      description: e.websiteDescription || e.productDescription || null,
      brand: e.productBrand || null,
      text: e.text || null,
    };
  }

  function normCluster(c, parentId = null) {
    return {
      id: String(c.id),
      name: c.name,
      slug: c.slug,
      description: c.description || '',
      isPrivate: !!c.isPrivate,
      parentId: parentId ?? (c.parentClusterId ? String(c.parentClusterId) : null),
      system: !!c.isPublicElementsCluster,
      owner: c.owner?.username || null,
      cover: c.coverImageUrl || null,
      expectedCount: c.numberOfElements ?? null,
      elementIds: [],
    };
  }

  /* /user/collection or /user/collection/sub-collection: the collection on screen, if any. */
  async function collectionOnPage() {
    const parts = PATH.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    if (parts.length < 2 || NOT_USER.has(parts[0].toLowerCase()) || NOT_COLLECTION.has(parts[1].toLowerCase())) return null;
    const sub = parts[2] && !NOT_COLLECTION.has(parts[2].toLowerCase()) ? parts[2] : null;
    try {
      const { cluster } = await gql('ClusterBySlug', { input: { slug: parts[1], ownerUsername: parts[0] }, sub, withSub: !!sub });
      if (!cluster) return null;
      if (sub && cluster.subCluster) return { owner: parts[0], clusters: [normCluster(cluster.subCluster, String(cluster.id))] };
      return {
        owner: parts[0],
        clusters: [normCluster(cluster), ...(cluster.subClusters?.items || []).map((s) => normCluster(s, String(cluster.id)))],
      };
    } catch (err) {
      if (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN') return null;
      throw err;
    }
  }

  try {
    ui.status('Connecting to Cosmos…');
    if (!env.anonymous) {
      if (!/(^|\.)cosmos\.so$/.test(location.hostname)) {
        throw new Error('Open https://www.cosmos.so, then run the export again from that tab.');
      }
      token = await refreshToken();
    }

    let me = env.me || null;
    let clusters = null;
    let includeLibrary = false;
    const onPage = await collectionOnPage();
    if (onPage) {
      clusters = onPage.clusters;
      me = me || { id: '', username: onPage.owner, fullName: '' };
    } else {
      if (!me) me = token || env.anonymous ? (await gql('Me').catch(() => ({ me: null }))).me : null;
      if (!me) throw Object.assign(new Error('Not signed in.'), { code: 'AUTHENTICATION' });
      ui.status('Reading your collections…');
      const top = await paginate('UserClusters', { userId: me.id }, (d) => d.userClusters);
      const byId = new Map();
      for (const c of top) {
        if (!byId.has(String(c.id))) byId.set(String(c.id), normCluster(c));
        for (const s of c.subClusters?.items || []) {
          if (!byId.has(String(s.id))) byId.set(String(s.id), normCluster(s, String(c.id)));
        }
      }
      const all = [...byId.values()];
      if (!all.length) throw new Error('No collections found on this account.');
      const names = new Map(all.map((c) => [c.id, c.name]));
      const picked = await ui.pick({
        heading: 'Pick the collections to send',
        noun: 'collection',
        items: all.map((c) => ({
          id: c.id,
          name: c.name,
          child: !!c.parentId,
          meta: [
            kit.count(c.expectedCount || 0, 'item'),
            c.isPrivate ? 'private' : '',
            c.parentId && names.has(c.parentId) ? `in ${names.get(c.parentId)}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        })),
        extra: { label: 'Also send the whole library, every item even unsorted', checked: false },
      });
      clusters = all.filter((c) => picked.ids.includes(c.id));
      includeLibrary = picked.extra;
    }

    const elements = {};
    const carousels = new Set();
    const addElement = (raw) => {
      if (!raw?.id) return null;
      const id = String(raw.id);
      if (!elements[id]) {
        elements[id] = normElement(raw);
        if (raw.hasMoreMedia) carousels.add(id);
      }
      return id;
    };

    const total = clusters.reduce((n, c) => n + (c.expectedCount || 0), 0);
    let done = 0;
    for (const [i, c] of clusters.entries()) {
      const label = clusters.length > 1 ? `Collection ${i + 1} of ${clusters.length} · ${c.name}` : c.name;
      const items = await paginate(
        'ClusterElements',
        { clusterId: Number(c.id), pageSize: PAGE_SIZE },
        (d) => d.clusterConnections,
        (n, count) => ui.status(label, total ? (done + n) / total : null, `${n} of ${count}`)
      );
      c.elementIds = items.map((it) => addElement(it.element)).filter(Boolean);
      done += c.elementIds.length;
    }

    let library = null;
    if (includeLibrary) {
      const items = await paginate(
        'LibraryElements',
        { userId: me.id, pageSize: PAGE_SIZE },
        (d) => d.allElementsV2,
        (n, count) => ui.status('Whole library', count ? n / count : null, `${n} of ${count}`)
      );
      library = { elementIds: items.map(addElement).filter(Boolean) };
    }

    let k = 0;
    for (const id of carousels) {
      ui.status('Carousels (extra images)', ++k / carousels.size, `${k} of ${carousels.size}`);
      try {
        const media = (await gql('ElementMedia', { elementId: Number(id) })).elementView?.media;
        if (media?.length) elements[id].media = coverFirst(normMediaList(media), elements[id].media[0]?.url);
      } catch {
        /* Keep the images already known for this carousel. */
      }
    }

    const data = {
      schema: 'arena-import/1',
      source: 'cosmos',
      exportedAt: new Date().toISOString(),
      user: { id: String(me.id || ''), username: me.username, fullName: me.fullName || '' },
      collections: clusters,
      library,
      elements,
    };
    const filename = `cosmos-export-${kit.safeName(me.username)}-${data.exportedAt.slice(0, 10)}.json`;
    const summary = `${kit.count(clusters.length, 'collection')}, ${kit.count(Object.keys(elements).length, 'item')}`;
    ui.status('Sending…', 1);
    if (env.save) {
      env.save(data, filename);
      ui.done(`Done: ${summary}.`, filename);
    } else if ((await (env.deliver || kit.deliver)(data, filename, env.toolOrigin)) === 'sent') {
      ui.done(`Sent to To Are.na: ${summary}.`, 'You can close this tab and go back to To Are.na.');
    } else {
      ui.done(`Done: ${summary}.`, `Downloaded as ${filename}. Add it on the To Are.na page.`, () => kit.download(data, filename));
    }
    return data;
  } catch (err) {
    if (err.cancelled) return null;
    ui.error(
      err.code === 'AUTHENTICATION'
        ? 'Sign in to Cosmos in this browser, or open one of your collections, then run the export again.'
        : err.message || String(err)
    );
    if (env.ui) throw err;
  }
}

if (typeof module !== 'undefined') module.exports = { cosmosExport };
