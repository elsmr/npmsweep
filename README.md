# npmsweep

Scan npm packages and report which symbols they import from a dependency.
Parses shipped JS and `.d.ts` with the TypeScript compiler API; declared
dependencies are ignored as a signal because most packages that declare a
dependency never import it, and some that import it never declare it.

## Run

```bash
bun install
bun npmsweep.ts scan   [--dep n8n-core] [--query <npm search>]… [--filter <regex>] [--limit N]
                       [--all] [--concurrency N≤16] [--reanalyze] [--refresh] [--symbol X]
bun npmsweep.ts report [--dep n8n-core] [--filter <regex>] [--symbol X]   # offline, from cache
bun npmsweep.ts selftest
```

- `--all`: download every package instead of only those declaring `--dep`. Use this; it's the only mode that finds real breakage.
- `--reanalyze`: reparse cached tarballs (after changing the analyzer). `--refresh`: redownload.
- Cache lives in `.cache/` next to the script: `meta/`, `tarballs/`, `results/<dep>/`.

## Example: who uses `n8n-core` exports?

```bash
bun npmsweep.ts scan --all --concurrency 16 > census.json   # 6035 packages, ~7 min
bun npmsweep.ts report --symbol Cipher                       # instant
```

```json
{ "symbol": "Cipher", "runtime": ["n8n@2.39.9"], "types": ["n8n@2.39.9"] }
```

Full report shape:

```json
{
  "scanned": 6035,
  "declaring": 857,
  "runtimeImporters": 17,
  "typeOnlyImporters": 171,
  "bySymbol":      { "BINARY_ENCODING": ["n8n-nodes-text-manipulation@1.4.0", "…"] },
  "typesBySymbol": { "IExecuteFunctions": ["n8n-nodes-pdfkit@0.1.2", "…"] },
  "errors": []
}
```

Result for that run: 857 packages declared `n8n-core`, 14 third-party packages imported it at runtime, 12 distinct symbols, `BINARY_ENCODING` in 7 of them.

## Notes

- npm's search endpoint rate-limits and caps at 10 000 results per query; tarball and metadata fetches did not 429 at 16 concurrent.
- Unresolvable usages (`const core = require('dep'); f(core)`) are reported under symbol `*`.
- Needs `typescript@5`; 7.x is the Go port and ships no compiler API.
