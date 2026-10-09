/*
 * To Are.na · Pinterest exporter
 *
 * Runs on https://www.pinterest.com, from the browser console (Pinterest's security policy blocks
 * bookmarklets in most browsers). Read-only: nothing changes on Pinterest. It reads the boards of
 * the profile you are on, or of your own account, with their sections and pins, then downloads a
 * JSON file for the import page. Secret boards are included when the profile is yours.
 *
 * `env` lets it run outside a browser (tests, Node): { origin, username, fetch, headers, ui, save }.
 */
async function pinterestExport(env = {}, kit = exportKit()) {
  /* The page's own domain: Pinterest serves local ones (fr.pinterest.com, pinterest.co.uk…). */
  const ORIGIN = env.origin || (typeof location !== 'undefined' ? location.origin : 'https://www.pinterest.com');
  const PAGE_SIZE = 50;
  const RESERVED = new Set(
    'pin,search,ideas,today,settings,business,resource,news_hub,notifications,board,explore,videos,shopping,login,signup,password,about,homefeed,_'.split(',')
  );

  const { sleep } = kit;
  const doFetch = env.fetch || ((...args) => fetch(...args));
  const ui = env.ui || kit.createOverlay('Pinterest → Are.na · export');

  const cookie = (name) =>
    typeof document === 'undefined' ? '' : (document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)) || [])[1] || '';

  function pageState() {
    try {
      return JSON.parse(document.getElementById('__PWS_DATA__').textContent);
    } catch {
      return null;
    }
  }

  /* The profile in the address bar, else the signed-in account. */
  function detectUsername() {
    if (env.username) return env.username;
    const first = location.pathname.split('/').filter(Boolean)[0];
    if (first && !RESERVED.has(first.toLowerCase())) return decodeURIComponent(first);
    return pageState()?.context?.user?.username || null;
  }

  async function resource(name, options, attempt = 0) {
    const url = new URL(`/resource/${name}Resource/get/`, ORIGIN);
    url.searchParams.set('source_url', '/');
    url.searchParams.set('data', JSON.stringify({ options, context: {} }));
    let res, body;
    try {
      res = await doFetch(url.toString(), {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Pinterest-AppState': 'active',
          'X-Pinterest-PWS-Handler': 'www/[username].js',
          'X-CSRFToken': cookie('csrftoken'),
          ...env.headers,
        },
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      if (attempt < 4) return sleep(1000 * 2 ** attempt).then(() => resource(name, options, attempt + 1));
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      ui.status(`Pinterest asks to slow down, retrying in ${2 ** attempt * 2} s`);
      await sleep(2000 * 2 ** attempt);
      return resource(name, options, attempt + 1);
    }
    if (!res.ok || body?.resource_response?.status !== 'success') {
      const err = new Error(`${name}: ${body?.resource_response?.message || `HTTP ${res.status}`}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function paginate(name, options, onPage) {
    const items = [];
    let bookmarks = null;
    for (let page = 0; page < 2000; page++) {
      const body = await resource(name, { ...options, ...(bookmarks && { bookmarks }) });
      let data = body.resource_response.data;
      if (data && !Array.isArray(data)) data = data.results || [];
      items.push(...(data || []));
      onPage?.(items.length);
      bookmarks = body.resource?.options?.bookmarks;
      if (!bookmarks?.length || bookmarks[0] === '-end-' || String(bookmarks[0]).startsWith('Y2JOb25lO')) break;
      await sleep(250);
    }
    return items;
  }

  const clean = (s) => (typeof s === 'string' ? s.trim() : '') || null;

  /* The original file when Pinterest lists one, else the widest size, rewritten to /originals/. */
  function bestImage(images) {
    if (!images) return null;
    const orig = images.orig || images.originals;
    if (orig?.url) return orig;
    const widest = Object.values(images)
      .filter((i) => i?.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return widest ? { ...widest, url: widest.url.replace(/\/\d+x\d*\//, '/originals/') } : null;
  }

  /* An MP4 Are.na can store; streaming-only (HLS) videos fall back to their cover image. */
  function bestVideo(video) {
    const list = video?.video_list || {};
    const preferred = ['V_720P', 'V_EXP7', 'V_EXP6', 'V_EXP5', 'V_EXP4', 'V_EXP3'].map((k) => list[k]);
    const mp4 = [...preferred, ...Object.values(list)].find((v) => /\.mp4(\?|$)/.test(v?.url || ''));
    return mp4 || null;
  }

  const asMedia = (type, m) => (m?.url ? { type, url: m.url, width: m.width ?? null, height: m.height ?? null } : null);
  const imageType = (url) => (/\.gif(\?|$)/i.test(url) ? 'AnimatedImage' : 'StaticImage');

  function pinMedia(p) {
    const cover = bestImage(p.images);
    const coverMedia = cover && asMedia(imageType(cover.url), cover);
    let media = [];
    if (p.carousel_data?.carousel_slots?.length) {
      media = p.carousel_data.carousel_slots.map((s) => {
        const img = bestImage(s.images);
        return img && asMedia(imageType(img.url), img);
      });
    } else if (p.videos) {
      const video = bestVideo(p.videos);
      media = [video ? { ...asMedia('Video', video), thumbnailUrl: cover?.url || null } : coverMedia];
    } else if (p.story_pin_data?.pages?.length) {
      media = p.story_pin_data.pages.map((page) => {
        const blocks = page.blocks || [];
        const video = blocks.map((b) => b.video && bestVideo(b.video)).find(Boolean);
        if (video) return asMedia('Video', video);
        const img = blocks.map((b) => bestImage(b.image?.images)).find(Boolean);
        return img && asMedia(imageType(img.url), img);
      });
      if (!media[0]) media[0] = coverMedia; /* the first page is the cover, even when it only streams */
    }
    media = media.filter(Boolean);
    if (!media.length && coverMedia) media = [coverMedia];
    const seen = new Set();
    return media.filter((m) => !seen.has(m.url) && seen.add(m.url));
  }

  function normPin(p) {
    const pinUrl = `https://www.pinterest.com/pin/${p.id}/`;
    return {
      id: String(p.id),
      kind: 'media',
      createdAt: p.created_at || null,
      url: pinUrl,
      caption: '',
      source: { url: clean(p.link) || pinUrl, author: null },
      media: pinMedia(p),
      title: clean(p.title) || clean(p.grid_title),
      description: clean(p.description) || clean(p.closeup_unified_description),
      alt: clean(p.alt_text) || clean(p.auto_alt_text),
      brand: null,
      text: null,
    };
  }

  try {
    ui.status('Connecting to Pinterest…');
    if (!env.origin && !/(^|\.)pinterest\.[a-z.]+$/.test(location.hostname)) {
      throw new Error('Open your profile on pinterest.com (signed in), then run the script again from that tab.');
    }
    const username = detectUsername();
    if (!username) {
      throw new Error('Open your Pinterest profile (click your picture, top right), then run the script again.');
    }

    ui.status(`Reading the boards of @${username}…`);
    const boards = (
      await paginate('Boards', {
        username,
        page_size: PAGE_SIZE,
        privacy_filter: 'all',
        sort: 'last_pinned_to',
        field_set_key: 'profile_grid_item',
        filter_stories: false,
        include_archived: true,
      })
    ).filter((b) => b?.id && b.type !== 'story');
    if (!boards.length) throw new Error(`No boards found for @${username}.`);

    const collections = [];
    const elements = {};
    const addPins = (pins) =>
      pins
        .filter((p) => p?.type === 'pin' && p.id)
        .map((p) => {
          const id = String(p.id);
          if (!elements[id]) elements[id] = normPin(p);
          return id;
        });

    const total = boards.reduce((n, b) => n + (b.pin_count || 0), 0);
    let done = 0;
    for (const [i, b] of boards.entries()) {
      const label = `Board ${i + 1} of ${boards.length} · ${b.name}`;
      const boardUrl = `https://www.pinterest.com${b.url || '/'}`;
      const board = {
        id: String(b.id),
        name: b.name,
        slug: (b.url || '').split('/').filter(Boolean).pop() || null,
        description: b.description || '',
        isPrivate: b.privacy === 'secret' || b.privacy === 'protected',
        parentId: null,
        system: false,
        owner: b.owner?.username || null,
        cover: b.image_cover_hd_url || b.image_cover_url || null,
        expectedCount: b.pin_count ?? null,
        includesChildren: true,
        url: boardUrl,
        elementIds: [],
      };
      const pins = await paginate(
        'BoardFeed',
        { board_id: board.id, board_url: b.url, field_set_key: 'react_grid_pin', prepend: false, page_size: PAGE_SIZE },
        (n) => ui.status(label, total ? (done + n) / total : null, `${n} of ${b.pin_count ?? '?'} pins`)
      );
      board.elementIds = addPins(pins);
      done += board.elementIds.length;
      collections.push(board);

      if (b.section_count) {
        const sections = await paginate('BoardSections', { board_id: board.id });
        for (const s of sections) {
          ui.status(`${label} · section ${s.title}`, total ? done / total : null);
          const sectionPins = await paginate('BoardSectionPins', { section_id: String(s.id), page_size: PAGE_SIZE });
          collections.push({
            id: String(s.id),
            name: s.title,
            slug: s.slug || null,
            description: '',
            isPrivate: board.isPrivate,
            parentId: board.id,
            system: false,
            owner: board.owner,
            cover: bestImage(s.preview_pins?.[0]?.images)?.url || null,
            expectedCount: s.pin_count ?? null,
            url: s.slug ? `${boardUrl}${s.slug}/` : boardUrl,
            elementIds: addPins(sectionPins),
          });
        }
      }
    }

    const data = {
      schema: 'arena-import/1',
      source: 'pinterest',
      exportedAt: new Date().toISOString(),
      user: { id: String(boards[0].owner?.id || ''), username, fullName: '' },
      collections,
      library: null,
      elements,
    };
    const filename = `pinterest-export-${kit.safeName(username)}-${data.exportedAt.slice(0, 10)}.json`;
    (env.save || kit.download)(data, filename);
    ui.done(`Done: ${kit.count(boards.length, 'board')}, ${kit.count(Object.keys(elements).length, 'pin')}.`, filename, () =>
      kit.download(data, filename)
    );
    return data;
  } catch (err) {
    ui.error(err.message || String(err));
    if (env.ui) throw err;
  }
}

if (typeof module !== 'undefined') module.exports = { pinterestExport };
