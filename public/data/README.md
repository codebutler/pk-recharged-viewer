# public/data/ — what the page and the parser load

Two kinds of JSON share this directory, both served to the browser:

**Parser tables — copies of `research/`.** The Python tools read `research/`; the
JS parser reads these copies, so the same tables load in Bun and in a browser.

| copy | canonical source | used by |
| --- | --- | --- |
| `hack-offsets.json` | `research/hack-offsets.json` | offset layer 2 (authoritative) |
| `offsets-discovered.json` | `research/tools/offsets-discovered.json` | offset layer 1 |
| `structs.json` | `research/structs.json` | charmap + substruct permutation |
| `gamedata.json` | `research/gamedata.json` | species/item/move/map name tables |
| `species-mapping.json` | `research/species-mapping.json` | internal→national ids (also read by the UI) |

Edit the file in `research/`, then refresh:

```sh
bun run sync-data
```

The two offset files load in the order above, matching `parse_ram.py`, so
`meta.config_layers` and every `meta.offsets[*].source` agree with the Python
output.

**Prepared view data — generated, not hand-edited.**

| file | produced by |
| --- | --- |
| `gamedata-view.json` | `bun run prepare-assets` (types, growth rates, sprite paths) |
| `manifest.json` | `bun run extract-rom-assets` (index of the ROM-derived art in `public/`) |

`manifest.json` records repo-relative paths (`public/maps/1.png`), which the app
resolves against the page URL, so it works from a GitHub Pages subpath too.
