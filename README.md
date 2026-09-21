# npmsweep

Scan npm packages and report which symbols they import from a dependency.
Parses shipped JS and `.d.ts` with the TypeScript compiler API. Declared
dependencies are not used as a signal: most packages that declare a dependency
never import it, and some that import it never declare it.

## Run

```bash
bun install
bun npmsweep.ts scan   --dep <name>... --query <npm search>... [--filter <regex>] [--exclude <regex>]
                       [--limit N] [--all] [--concurrency N≤16] [--reanalyze] [--refresh] [--symbol X]
bun npmsweep.ts report --dep <name>... [--filter <regex>] [--exclude <regex>] [--symbol X]   # offline
bun npmsweep.ts selftest
```

- `--query` takes any npm search text, including qualifiers (`keywords:foo`, `author:bar`, `scope:baz`). Repeatable; results are unioned. npm caps each query at 10 000 results.
- `--all`: download every package instead of only those declaring a `--dep`. Use it; it's the only mode that finds real breakage.
- `--reanalyze`: reparse cached tarballs (after changing the analyzer or adding a `--dep`). `--refresh`: redownload.
- Cache lives in `.cache/` next to the script: `meta/`, `tarballs/`, `results/<dep>/`.

## Example: who uses `BINARY_ENCODING` from `n8n-core`?

```bash
bun npmsweep.ts scan --dep n8n-core \
  --query 'keywords:n8n-community-node-package' --query 'n8n-nodes-' \
  --exclude '^(n8n|n8n-nodes-base|@n8n/.*)$' \
  --all --concurrency 16 > census.json          # 6026 packages, ~7 min cold, ~3 min from cache

bun npmsweep.ts report --dep n8n-core --symbol BINARY_ENCODING
```

```json
{
  "symbol": "BINARY_ENCODING",
  "deps": {
    "n8n-core": {
      "runtime": [
        "n8n-nodes-text-manipulation@1.4.0",
        "@planasli/n8n-nodes-bale@1.0.0",
        "n8n-nodes-bale-messenger@0.2.11",
        "n8n-nodes-bale-messenger-alpha@0.4.0",
        "@5stones/n8n-nodes-xero@1.0.0-alpha.7",
        "@codejamninja/n8n-nodes-base@0.31.1",
        "n8n-nodes-sonatazvit@0.2.44"
      ],
      "types": []
    }
  }
}
```

Without `--symbol`, each dep gets a full section:

```json
{
  "scanned": 6026,
  "deps": {
    "n8n-core": {
      "declaring": 853,
      "runtimeImporters": 14,
      "typeOnlyImporters": 172,
      "bySymbol":      { "BINARY_ENCODING": ["…"], "isEngineRequest": ["…"] },
      "typesBySymbol": { "IExecuteFunctions": ["…"] },
      "skippedFiles":  ["n8n-nodes-debounce@2.2.7:package/dist/nodes/DebounceWebhook/DebounceWebhook.node.js"]
    }
  },
  "errors": []
}
```

Read: 853 packages declare `n8n-core`, 14 import it at runtime, 7 of those use `BINARY_ENCODING`.

## Notes

- Unresolvable usages (`const core = require('dep'); f(core)`) are reported under symbol `*`.
- `skippedFiles` lists files the parser gave up on (typically huge bundles); the rest of the package is still counted.
- npm's search endpoint rate-limits; tarball and metadata fetches did not 429 at 16 concurrent.
- Needs `typescript@5`; 7.x is the Go port and ships no compiler API.
