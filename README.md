# To Are.na

Move your [Cosmos](https://www.cosmos.so) and [Pinterest](https://www.pinterest.com) saves into
[Are.na](https://www.are.na) channels: each collection or board becomes a channel, with its images, videos, links,
captions and sources, in the same order.

![To Are.na](docs/screenshot.png)

> **Vibe-coded.** This tool was built with an AI assistant. It works well and is tested, but it isn’t a polished
> product: try one small collection first, and check the result on Are.na.

Not affiliated with Are.na, Cosmos or Pinterest.

## Open it

There is nothing to install. Pick one:

### Online, the simplest

Open **[tanguycaruel.github.io/to-arena](https://tanguycaruel.github.io/to-arena/)** in Chrome, Safari, Firefox, Edge
or Arc. Everything runs in your browser: your saves and your Are.na access never go through another server.

### On your computer, Mac or Windows

1. Download **[To-Arena.zip](https://github.com/TanguyCaruel/to-arena/releases/latest/download/To-Arena.zip)**.
2. Unzip it: double-click it on a Mac; on Windows, right-click it, then **Extract All**.
3. Open the **To Are.na** folder and double-click **index.html**. It opens in your web browser.

If the page says it isn’t running, open `index.html` with Chrome, Edge or Firefox instead (right-click › Open With).
The downloaded version can’t send your boards back by itself: the script downloads a file, which you add to the page.

## Use it

You need an Are.na account, a computer, and your Cosmos or Pinterest account open in the same browser.

1. **Source.** Pick Cosmos or Pinterest.
2. **Pick.** Press **Open Pinterest** (or **Open Cosmos**) on the page, then run the small script on the site:
   - Cosmos: drag the **Send to Are.na** button to your bookmarks bar once, then click it on cosmos.so.
   - Pinterest: copy the script, open the browser console and paste it. The page shows the right keys for your
     browser. Pinterest blocks bookmark buttons, except in Firefox.

   On a board or a collection, the script sends just that one, with its sections or sub-collections. On your
   profile, it lists them and you tick the ones you want. They come back to the To Are.na tab by themselves.
3. **Connect.** Press **Connect with Are.na** and allow access, or paste an
   [Are.na personal access token](https://www.are.na/settings/personal-access-tokens) with **read and write** access.
   The page checks that it can write, then you pick the channel privacy and how to handle carousels.
4. **Transfer.** Read the summary, **Simulate first** if you like, then **Transfer**. You can pause and resume.

## What goes where

| Source | Are.na |
| --- | --- |
| Cosmos collection, Pinterest board | Channel (private stays private by default) |
| Cosmos sub-collection, Pinterest section | Channel placed inside its parent’s channel |
| Image, GIF | Image block |
| Video | Attachment block (`.mp4`); Pinterest videos that only stream fall back to their cover image |
| Carousel, Pinterest idea pin | The cover image by default; optionally one block per image, titled “(1/5)”, “(2/5)”… |
| Item saved from Are.na (`are.na/block/…`, image on Are.na’s CDN) | Connection to the original block, as if connected from Are.na |
| Are.na channel saved as a link (`are.na/user/channel`) | Connection of the real channel |
| Link to a website (Cosmos) | Link block, with the Cosmos preview as cover |
| Text (Cosmos) | Text block |
| Cosmos caption | Title (first sentence), description and alt text |
| Pinterest title, description, alt text | Same fields on the block |
| Source link and author | The block’s source, and a “Via …” credit (Cosmos) |
| Item in several collections | One block connected to several channels |
| Whole Cosmos library (optional) | A “Cosmos · all items” channel |

A Pinterest board also lists the pins of its sections: when a section is imported as its own channel inside the
board’s channel, those pins are not repeated in the board’s channel. If the original of an Are.na item is missing or
private, a copy is made instead. The order is kept: items are sent from the oldest to the newest, and Are.na shows
the latest additions first.

## Good to know

- **Free Are.na accounts hold 200 blocks in total.** The page warns you before a transfer that goes over.
- **It takes time.** Are.na limits how many changes it accepts per minute and per hour. The tool spaces its
  requests and, when a limit is reached, waits by itself with a countdown. Keep the tab open; a few thousand items
  can take several hours.
- **No duplicates.** Each block made is noted in your browser and tagged on Are.na with the id of the original item.
  Pause, close the page, switch browsers or retry failed items: what already exists is found and skipped.
- **Images.** Are.na fetches each file from Cosmos or Pinterest. When it refuses a link, the page uploads the file
  itself (or always, with “Upload from this browser” in the advanced options).
- **The exports may break one day.** They rely on the internal, undocumented APIs of Cosmos and Pinterest; if either
  site changes, its export may stop working. The import uses Are.na’s public API.

## Security

- **Your Are.na access** (the token, or the access given by **Connect with Are.na**) is only sent to `api.are.na`;
  the page’s Content Security Policy blocks any other destination. By default it is forgotten when you close the tab.
  “Remember the connection on this computer” keeps it in the browser’s storage, which other pages from the same
  address could read (other local files, or other pages under `tanguycaruel.github.io`): avoid it on a shared
  computer, and revoke the access on Are.na when you are done. The write check on **Connect** changes nothing.
- **Connect with Are.na** uses OAuth with PKCE: no secret in the page, a one-time code that only this tab can
  exchange, and a state value checked on return.
- **The export scripts** only read: Cosmos GraphQL queries and Pinterest `GET` requests, made with your open
  session. No password is involved and nothing is written on Cosmos or Pinterest. The result goes only to the To
  Are.na tab that opened the site, after a handshake that checks its exact address; otherwise it is downloaded.
  Paste into a console only code you trust: these scripts come from the page itself.
- **Export files are treated as untrusted.** Text is shown as text, never as HTML. Only `http(s)` links are kept,
  media must be `https`, and thumbnails and uploads only come from the Cosmos and Pinterest image hosts.
- **The page** loads nothing from outside its own folder: no CDN, no tracker, no external font.

## For developers

No build step and no dependency: plain HTML, CSS and JavaScript.

| File | Role |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The page |
| `arena.js` | The engine: export files, Are.na API client, transfer plan, resume, rate limits |
| `cosmos-export.js`, `pinterest-export.js` | The export scripts; the page builds the bookmark and console scripts from them |
| `export-kit.js` | Shared pieces of the export scripts: panel and picker, sending to the tool, download |
| `oauth.html`, `oauth.js` | Return page of **Connect with Are.na** |
| `demo/` | The demo: the real page with simulated sites and Are.na (`mock-sources.js`) |
| `tests/` | Engine and export-script tests against the simulations |

```bash
node tests/import.test.mjs
node tests/export.test.mjs
```

**Connect with Are.na** needs an Are.na OAuth application: create one at
[are.na/developers/oauth/applications](https://www.are.na/developers/oauth/applications) with the redirect address
`https://tanguycaruel.github.io/to-arena/oauth.html`, then put its client ID in `OAUTH_CLIENT_ID` at the top of
`app.js`. Without it, the page asks for a personal access token instead.

To publish a new version of the download, zip the page files (without `tests/` and `demo/`) in a folder named
`To Are.na`, then attach `To-Arena.zip` to a new [release](https://github.com/TanguyCaruel/to-arena/releases). Bump
`VERSION` in `demo/boot.js` so the demo loads the new scripts.

## License

Free and open source, under the [MIT license](LICENSE): use it, change it, share it.
