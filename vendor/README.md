# vendor/ — submodules

Four git submodules. Two are pret's decompilation projects, `pokeemerald` (the
engine this hack was built from — the authoritative reference) and `pokefirered`
(a historical dead end, kept for the record). The other two are shallow PokéAPI
mirrors, used by `tools/prepare-assets.js` to resolve sprites and metadata
locally instead of crawling the network (raw.githubusercontent.com rate-limits
rapid sequential sprite fetches):

```sh
git clone --depth 1 https://github.com/PokeAPI/api-data vendor/pokeapi-data
git clone --depth 1 https://github.com/PokeAPI/sprites  vendor/pokeapi-sprites
```

- `pokeapi-data/data/api/v2/...` — the static JSON of the PokéAPI (pokemon,
  item, index files). ~700 MB.
- `pokeapi-sprites/sprites/...` — sprite PNGs; sprite URLs inside api-data map
  1:1 onto this tree by stripping the
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/` prefix. GB-scale.

The PokéAPI clones are needed only to re-run `bun run prepare-assets`; the app
itself ships the prepared subset under `public/` and never touches `vendor/`.
