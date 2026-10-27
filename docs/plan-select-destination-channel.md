# Plan: pick an existing are.na channel as destination

## Goal

For each source board/collection being imported, let the user either:
- **Create new** — current behaviour, or
- **Pick existing** — route the import into one of their existing are.na channels.

Also: an option to **prepend the parent channel's name to nested children**, so e.g. the Pinterest section `figure - line` inside the board `Drawing`, mapped onto the existing channel `drawing`, becomes the nested channel `drawing - figure - line`.

## Why

The current dedup only recognises channels this tool previously created (via a source-id tag in channel `metadata`). Any channel the user made by hand — or in a different tool — is invisible to it, so re-importing creates a duplicate. Users also want flatter, path-aware names to avoid losing context when sections are nested or flattened.

## Context the agent must respect

- **Upstreaming is planned.** All changes must be strictly backward-compatible: new `buildPlan`/`runImport` options optional with current behaviour as the default; no renames or signature changes; no refactors that aren't necessary for the feature.
- **are.na API v3 only.** Keep using `https://api.are.na/v3` via the existing `ArenaClient`. All new reads/writes route through it so the rate limiter and 429/503 backoff still apply.
- **Design language is set.** Reuse existing CSS classes (`.row`, `.check`, `.choice`, `.btn`, `.list`, `.toolbar`, filter input pattern). No new palette, no new typography, no new spacing scale. Arial everywhere, per the latest commit on `main`.
- **No new runtime dependencies.** Plain HTML/CSS/JS, no build step — same as the rest of the project.
- Branch: `select-destination-channel` (already created).

## Non-goals

- No changes to `cosmos-export.js`, `pinterest-export.js`, `export-kit.js`.
- No changes to OAuth, token handling, or `oauth.*`.
- No changes to block-level dedup.
- No merging of two existing channels together.
- No bulk rename of blocks already on are.na.

## Code map

| Area | File | Current state | Change |
|---|---|---|---|
| Options object | `app.js` → `options()` (~L752) | `{ selected, visibility, nest, carousel, arenaLinks, captions, credits }` | Add `destinations: { [collectionId]: 'new' \| { channelId, slug, title, visibility } }` and `prefixNested: boolean`. Both default to current behaviour. |
| Per-row UI | `app.js` → `collectionRow()` (~L459) and `index.html` → `#collections` | Checkbox + thumb + name/meta | Add a destination control at the right of the row. Compact `<select>` with "Create new" (default) and "Pick existing…". Reuse existing row/check styling. |
| Picker | `app.js` + `index.html` + `styles.css` | n/a | A modal/panel listing the user's channels: filter input (reuse `.toolbar` + `#filter` pattern), scroll list of channel rows (reuse `.row` + `.list`), Cancel/Choose buttons (reuse `.btn`). Fetched once when entering the Transfer step, cached in `state`. |
| Nested-name option | `index.html` under existing options block (around visibility/nest) and `app.js` | n/a | Add `<label class="check"><input type="checkbox" id="prefix-nested" /> <span>Prepend parent channel name to nested channels</span></label>`. Not default-on. |
| List user's channels | `arena.js` | `listAll(client, '/users/{me.id}/contents', { type: 'Channel' })` already used in `reconcile()` | Export a `listUserChannels(client, me, checkAbort)` returning `[{ id, slug, title, visibility, length, metadata }]`. Reuse `listAll`. |
| Plan building | `arena.js` → `buildPlan()` (~L381) | Each selected collection → new channel object keyed `${prefix}${c.id}` | When `destinations[c.id]` is an existing channel, set `targetChannelId`, `targetSlug`, keep `targetVisibility` on the plan channel. When `prefixNested` is true and the channel has a `parentKey`, prepend the resolved parent title + " - " to its title. |
| Transfer loop | `arena.js` → `runImport()` channel-creation block (~L586–603) | Always POSTs `/channels` unless journal has the key | If `targetChannelId` is set and journal is empty for the key, GET `/channels/{id}`; seed `journal.channels[ch.key]` with its real id/slug/title/owner. Count as `channelsReused`. Do not POST. |
| Back-tag picked channels | `arena.js` → right after seeding | n/a | PATCH the picked channel's metadata with the source-id tag so the next run auto-matches without re-picking. Guard: only tag if the metadata key isn't already set to this value. |
| Visibility | `arena.js` → `visibilityFor()` | New channels get visibility from the mode | **Do not** change visibility of a picked existing channel. Surface this in the review summary. |
| Review summary | `app.js` → `updateTransfer()` (~L765) | "Channels", "Extra connections…" rows | Split "Channels" into "New channels: N" and "Using existing: N" when any destination is picked. Add a note if any picked channel's visibility doesn't match the `visibility` mode selected. |
| README | `README.md` | "Use it" + "What goes where" | Add a short paragraph: how the destination control works, and the name-prefix option. One line in "What goes where" for picked destinations. |

## Rename logic (nested-child prefix)

- Only applies to channels with a `parentKey` resolvable in the same plan.
- Separator: ` - ` (space, hyphen, space) — matches Kim's example.
- Prefix source:
  - If parent destination is **existing**: use the picked channel's `title` as-is (preserve case; the are.na channel's own title wins over the source collection's name).
  - If parent destination is **new**: use the source collection's original name.
- Multi-level nesting (edge case; Cosmos sub-collections can go deeper than Pinterest sections): walk the chain, so `A - B - C`.
- Collision with another of the user's channels is **not** blocked. A new channel with a clashing name is still allowed — the user can later point at it manually.
- Applies regardless of whether `nest` is on. When `nest` is off and `prefixNested` is on, flattened children keep their lineage in the name.

## Edge cases to cover in tests

1. **Pick existing + no journal.** Picked channel is seeded from a GET; no POST `/channels` is sent; blocks are added to it.
2. **Pick existing + previous run exists.** Journal already has the key from a prior run; GET is skipped; behaviour matches current reconcile path.
3. **Pick existing then re-run.** Second run finds the channel through the metadata tag added on first run (confirms the back-tag works).
4. **Mix.** One collection "new", a second "existing" — plan builds correctly, nests resolve correctly.
5. **Nested prefix on.** Child title becomes `{parentTitle} - {childName}`; multi-level walks the chain.
6. **Nested prefix off.** Current behaviour untouched.
7. **Picked channel deleted between pick and transfer.** GET returns 404 → fall back to creating a new channel; log a `warn`. (Mirrors existing `verifyJournal` fallback.)
8. **Visibility mismatch.** Source is public, picked channel is private → channel stays private; review summary notes it.
9. **Same existing channel chosen twice.** UI prevents a destination channel from being picked for more than one collection; add a client-side guard with a short error.
10. **Simulate/dry-run.** `DryRunClient` must not need extra stubs; the picked-channel GET and PATCH should be no-ops under dry-run (seed the journal from the picker's cached data instead; skip PATCH).
11. **Library pseudo-channel** ("Cosmos · all items") is new-only — no destination picker shown.

## Suggested commit sequence

1. `arena.js` — add `listUserChannels` export; extend `buildPlan` with `destinations` + `prefixNested` (defaults preserve current behaviour); extend `runImport` to honour `targetChannelId`. Tests first.
2. `app.js` — `state.availableChannels`; fetch on entering Transfer; `options()` passes new fields through.
3. `index.html` + `styles.css` — per-row destination control, picker modal, `prefix-nested` checkbox, review-summary tweaks. Reuse existing classes.
4. `arena.js` — metadata back-tag PATCH on picked channels (small, separable commit so it can be reverted alone).
5. `README.md` — documentation.
6. Version bump in `demo/boot.js` and a note in the README release instructions.

Each commit should leave the test suite green:

```bash
node tests/import.test.mjs
node tests/export.test.mjs
```

## Backward compatibility checklist (upstream-friendly)

- `buildPlan(data)` and `buildPlan(data, {})` behave identically to before.
- `runImport({ plan, client, journal, me, … })` with a plan from the old `buildPlan` behaves identically.
- No existing option keys renamed. No existing event names changed. Journal format unchanged.
- No new network calls on the current flow (channel-list fetch happens only when the user opens the picker, or lazily when the Transfer screen is reached).
- Rate-limit respect: all new calls go through `ArenaClient.request` — no `fetch` bypass.
- UI: existing selectors, classes, IDs and layout preserved. New controls are additive.

## Open questions (defer to user if hit)

- Should the picker show channels the user is a *collaborator* on, or only ones they own? Default: only owned (safer; matches `/users/{me.id}/contents`).
- When back-tagging a picked channel, should the existing `metadata` be preserved (merge) or replaced? Must **merge** — are.na metadata is a free-form bag used by other tools too.

## Possible enhancements (out of scope for the first pass)

Noted here so they aren't lost. Do not build unless explicitly asked.

1. **Secondary block dedup by `original_source_url` when the destination is a picked existing channel.** Rationale: the current block-level dedup matches on the `pinterest_pin_id` / `cosmos_element_id` tag in a block's metadata, so a pin the user previously added to the picked channel by hand (no metadata) would be imported again as a fresh copy. A secondary pass could, before creating a block, check the channel's existing contents for a block whose `source.url` matches `original_source_url` and connect to it instead. Costs one extra list of the channel's contents per picked destination (already paginated via `listAll`), plus a per-block lookup. Only triggers when `destinations[c.id]` is an existing channel.

2. **Carry more Pinterest fields through.** The export currently ignores: the per-save "note" annotation some users add on save; saves/reactions counts; pin creator vs. saver identity; repin ancestry. Any of these could be added to `normPin()` in `pinterest-export.js` and surfaced on the are.na block (likely into `description` or a new metadata key such as `pinterest_note`). Scope: export-side change plus a payload-field addition in `blockPayloads()`.
