/*
 * To Are.na · Cosmos exporter
 *
 * Runs on https://www.cosmos.so while you are signed in (bookmarklet or browser console).
 * Read-only: nothing changes on Cosmos. It reads your collections (private ones too), their
 * sub-collections and every item in them, then downloads a JSON file for the import page.
 *
 * `env` lets it run outside a browser (tests, Node): { anonymous, me, clusters, includeLibrary, ui, save }.
 */
async function cosmosExport(env = {}, kit = exportKit()) {
  const API = 'https://api.cosmos.so/graphql';
  const PAGE_SIZE = 500;

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
  const ui = env.ui || kit.createOverlay('Cosmos → Are.na · export');
  let token = null;

  /* The site's own session endpoint hands out a short-lived access token: no password involved. */
  async function refreshToken() {
    try {
      const res = await fetch('/api/refresh-token', {
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
      res = await fetch(`${API}?q=${name}`, {
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

  try {
    ui.status('Connecting to Cosmos…');
    if (!env.anonymous) {
      if (!/(^|\.)cosmos\.so$/.test(location.hostname)) {
        throw new Error('Open https://www.cosmos.so (signed in), then run the export again from that tab.');
      }
      token = await refreshToken();
    }
    const me = env.me || (await gql('Me')).me;
    if (!me) throw Object.assign(new Error('Not signed in.'), { code: 'AUTHENTICATION' });

    ui.status('Reading your collections…');
    let clusters;
    if (env.clusters) {
      clusters = env.clusters.map((c) => normCluster(c));
    } else {
      const top = await paginate('UserClusters', { userId: me.id }, (d) => d.userClusters);
      const byId = new Map();
      for (const c of top) {
        if (!byId.has(String(c.id))) byId.set(String(c.id), normCluster(c));
        for (const s of c.subClusters?.items || []) {
          if (!byId.has(String(s.id))) byId.set(String(s.id), normCluster(s, String(c.id)));
        }
      }
      clusters = [...byId.values()];
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
      const label = `Collection ${i + 1} of ${clusters.length} · ${c.name}`;
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
    if (env.includeLibrary !== false) {
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
      user: { id: String(me.id), username: me.username, fullName: me.fullName || '' },
      collections: clusters,
      library,
      elements,
    };
    const filename = `cosmos-export-${kit.safeName(me.username)}-${data.exportedAt.slice(0, 10)}.json`;
    (env.save || kit.download)(data, filename);
    ui.done(`Done: ${kit.count(clusters.length, 'collection')}, ${kit.count(Object.keys(elements).length, 'item')}.`, filename, () =>
      kit.download(data, filename)
    );
    return data;
  } catch (err) {
    ui.error(
      err.code === 'AUTHENTICATION'
        ? 'You are not signed in to Cosmos in this browser. Sign in on cosmos.so, then run the export again.'
        : err.message || String(err)
    );
    if (env.ui) throw err;
  }
}

if (typeof module !== 'undefined') module.exports = { cosmosExport };
