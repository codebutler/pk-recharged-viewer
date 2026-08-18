# vendor/ — local PokéAPI mirrors

Shallow clones used by `analysis/tools/generate_page.py` to resolve sprites and
metadata locally instead of crawling the network (raw.githubusercontent.com
rate-limits rapid sequential sprite fetches):

```sh
git clone --depth 1 https://github.com/PokeAPI/api-data vendor/pokeapi-data
git clone --depth 1 https://github.com/PokeAPI/sprites  vendor/pokeapi-sprites
```

- `pokeapi-data/data/api/v2/...` — the static JSON of the PokéAPI (pokemon,
  item, index files). ~700 MB.
- `pokeapi-sprites/sprites/...` — sprite PNGs; sprite URLs inside api-data map
  1:1 onto this tree by stripping the
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/` prefix. GB-scale.

Optional but recommended: without these clones, generate_page.py falls back to
throttled HTTP fetches with a disk cache (`analysis/report/.cache/`) — slow on
first run — and finally to styled placeholders for anything unresolvable.
