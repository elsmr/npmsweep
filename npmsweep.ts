#!/usr/bin/env bun
// Which npm packages import symbols from a given dependency (default n8n-core)?
//
//   bun npmsweep.ts scan [--dep n8n-core] [--query <npm search>]... [--filter <regex>] [--limit N]
//                     [--all] [--concurrency N] [--reanalyze] [--refresh] [--symbol X]
//   bun npmsweep.ts report [--dep n8n-core] [--filter <regex>] [--symbol X]     # cache only
//   bun npmsweep.ts selftest
//
// --all downloads every package instead of only those that declare --dep in package.json.
// Packages resolve host-installed deps at runtime without declaring them, so --all is the
// only mode that finds real breakage. --reanalyze reparses cached tarballs; --refresh redownloads.

import ts from 'typescript';
import { gunzipSync } from 'node:zlib';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- result

type Ok<T> = { readonly ok: true; readonly value: T };
type Err<E> = { readonly ok: false; readonly error: E };
type Result<T, E = string> = Ok<T> | Err<E>;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = <E>(error: E): Err<E> => ({ ok: false, error });
const attempt = <T>(ctx: string, fn: () => T): Result<T> => {
	try {
		return ok(fn());
	} catch (e) {
		return err(`${ctx}: ${e instanceof Error ? e.message : String(e)}`);
	}
};
const attemptAsync = async <T>(ctx: string, fn: () => Promise<T>): Promise<Result<T>> => {
	try {
		return ok(await fn());
	} catch (e) {
		return err(`${ctx}: ${e instanceof Error ? e.message : String(e)}`);
	}
};

// ---------------------------------------------------------------- cli

type Command = 'scan' | 'report' | 'selftest';
type Options = {
	readonly command: Command;
	readonly dep: string;
	readonly queries: readonly string[];
	readonly filter: RegExp | undefined;
	readonly all: boolean;
	readonly reanalyze: boolean;
	readonly refresh: boolean;
	readonly symbol: string | undefined;
	readonly limit: number;
	readonly concurrency: number;
	readonly cacheDir: string;
};

const COMMANDS: readonly Command[] = ['scan', 'report', 'selftest'];
const DEFAULT_QUERIES = ['keywords:n8n-community-node-package', 'n8n-nodes-'];
const isCommand = (s: string | undefined): s is Command => COMMANDS.includes(s as Command);

const parseArgs = (argv: readonly string[]): Result<Options> => {
	const [command, ...rest] = argv;
	if (!isCommand(command)) return err(`usage: bun npmsweep.ts <${COMMANDS.join('|')}> [options]`);
	const flag = (n: string) => rest.includes(n);
	const opts = (n: string) => rest.flatMap((a, i) => (a === n && rest[i + 1] !== undefined ? [rest[i + 1] as string] : []));
	const opt = (n: string) => opts(n).at(-1);
	const filter = opt('--filter');
	return ok({
		command,
		dep: opt('--dep') ?? 'n8n-core',
		queries: opts('--query').length ? opts('--query') : DEFAULT_QUERIES,
		filter: filter ? new RegExp(filter) : undefined,
		all: flag('--all'),
		reanalyze: flag('--reanalyze'),
		refresh: flag('--refresh'),
		symbol: opt('--symbol'),
		limit: Number(opt('--limit') ?? Infinity),
		// npm publishes no limit; 24 concurrent produced no 429s, 16 leaves headroom.
		concurrency: Math.min(16, Number(opt('--concurrency') ?? 8)),
		cacheDir: join(fileURLToPath(new URL('.', import.meta.url)), '.cache'),
	});
};

// ---------------------------------------------------------------- http

const HEADERS = { 'user-agent': 'npmsweep (https://github.com/elsmr/npmsweep)' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fetchRetry = async (url: string, tries = 5): Promise<Result<Response>> => {
	const res = await attemptAsync(url, () => fetch(url, { headers: HEADERS }));
	if (!res.ok) return res;
	const retryable = res.value.status === 429 || res.value.status >= 500;
	if (retryable && tries > 1) {
		const after = Number(res.value.headers.get('retry-after')) * 1000;
		await sleep(after || 500 * 2 ** (5 - tries));
		return fetchRetry(url, tries - 1);
	}
	return res.value.ok ? res : err(`${res.value.status} ${url}`);
};

const getJson = async <T>(url: string): Promise<Result<T>> => {
	const res = await fetchRetry(url);
	return res.ok ? attemptAsync(url, () => res.value.json() as Promise<T>) : res;
};

const getBuffer = async (url: string): Promise<Result<Buffer>> => {
	const res = await fetchRetry(url);
	return res.ok ? attemptAsync(url, async () => Buffer.from(await res.value.arrayBuffer())) : res;
};

// ---------------------------------------------------------------- registry

type PackageRef = { readonly name: string; readonly version: string };
type SearchPage = { readonly objects: ReadonlyArray<{ readonly package: PackageRef }> };
type Manifest = Readonly<Record<string, Record<string, string> | undefined>>;

const SEARCH_PAGE = 250;
const SEARCH_CAP = 10_000;
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'] as const;

const searchPage = (query: string, from: number) =>
	getJson<SearchPage>(
		`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${SEARCH_PAGE}&from=${from}`,
	);

const listPackages = async ({ queries, filter, limit }: Options): Promise<Result<readonly PackageRef[]>> => {
	const seen = new Map<string, PackageRef>();
	const matches = (p: PackageRef) => !filter || filter.test(p.name);
	for (const query of queries) {
		for (let from = 0; from < SEARCH_CAP && seen.size < limit; from += SEARCH_PAGE) {
			const page = await searchPage(query, from);
			if (!page.ok) return page;
			if (!page.value.objects.length) break;
			page.value.objects.filter((o) => matches(o.package)).forEach((o) => seen.set(o.package.name, o.package));
		}
	}
	return ok([...seen.values()].slice(0, limit));
};

const tarballUrl = ({ name, version }: PackageRef) =>
	`https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

type DepFields = Readonly<Record<string, Record<string, string>>>;
const depFieldsOf = (manifest: Manifest): DepFields =>
	Object.fromEntries(DEP_FIELDS.flatMap((k) => (manifest[k] ? [[k, manifest[k]]] : [])));
const declaredIn = (fields: DepFields, dep: string): readonly string[] =>
	Object.entries(fields).flatMap(([k, deps]) => (deps[dep] ? [`${k}:${deps[dep]}`] : []));

// ---------------------------------------------------------------- tar

type TarEntry = { readonly path: string; readonly body: Buffer };

const cstr = (buf: Buffer, start: number, end: number) =>
	buf.toString('utf8', start, end).replace(/\0.*$/s, '');

// Minimal ustar + pax reader; regular files only.
function* tarEntries(tgz: Buffer): Generator<TarEntry> {
	const buf = gunzipSync(tgz);
	let off = 0;
	let paxPath: string | undefined;
	while (off + 512 <= buf.length && buf[off] !== 0) {
		const name = cstr(buf, off, off + 100);
		const prefix = cstr(buf, off + 345, off + 500);
		const size = parseInt(buf.toString('ascii', off + 124, off + 136), 8) || 0;
		const type = String.fromCharCode(buf[off + 156] ?? 0);
		const body = buf.subarray(off + 512, off + 512 + size);
		off += 512 + Math.ceil(size / 512) * 512;
		if (type === 'x') {
			paxPath = body.toString().match(/\d+ path=(.*)\n/)?.[1];
			continue;
		}
		if (type === '0' || type === '\0') {
			yield { path: paxPath ?? (prefix ? `${prefix}/${name}` : name), body };
		}
		paxPath = undefined;
	}
}

// ---------------------------------------------------------------- analyzer

type SymbolCounts = Readonly<Record<string, number>>;
type Analysis = { readonly runtime: SymbolCounts; readonly types: SymbolCounts };

const UNRESOLVED = '*';

const tally = (names: readonly string[]): SymbolCounts =>
	names.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n]: (acc[n] ?? 0) + 1 }), {});

const mergeCounts = (a: SymbolCounts, b: SymbolCounts): SymbolCounts =>
	Object.entries(b).reduce((acc, [k, v]) => ({ ...acc, [k]: (acc[k] ?? 0) + v }), { ...a });

const isSpecifier = (dep: string, n: ts.Node | undefined): boolean =>
	n !== undefined && ts.isStringLiteralLike(n) && n.text === dep;

const isRequireOf = (dep: string, n: ts.Node): n is ts.CallExpression =>
	ts.isCallExpression(n) &&
	ts.isIdentifier(n.expression) &&
	n.expression.text === 'require' &&
	n.arguments.length === 1 &&
	isSpecifier(dep, n.arguments[0]);

type Found = { readonly direct: readonly string[]; readonly bindings: readonly string[] };
const none: Found = { direct: [], bindings: [] };
const direct = (...names: string[]): Found => ({ direct: names, bindings: [] });
const binding = (name: string): Found => ({ direct: [], bindings: [name] });
const concat = (a: Found, b: Found): Found => ({
	direct: [...a.direct, ...b.direct],
	bindings: [...a.bindings, ...b.bindings],
});

const fromBindingName = (name: ts.BindingName): Found => {
	if (ts.isIdentifier(name)) return binding(name.text);
	if (ts.isObjectBindingPattern(name)) {
		return direct(
			...name.elements.map((e) =>
				e.propertyName && ts.isIdentifier(e.propertyName)
					? e.propertyName.text
					: ts.isIdentifier(e.name)
						? e.name.text
						: UNRESOLVED,
			),
		);
	}
	return direct(UNRESOLVED);
};

// Walks up from `require(dep)` to see how its result is consumed.
const fromRequireUse = (node: ts.Node): Found => {
	const p = node.parent;
	if (!p) return direct(UNRESOLVED);
	if (ts.isPropertyAccessExpression(p) && p.expression === node) return direct(p.name.text);
	if (ts.isElementAccessExpression(p) && ts.isStringLiteralLike(p.argumentExpression)) {
		return direct(p.argumentExpression.text);
	}
	if (ts.isVariableDeclaration(p)) return fromBindingName(p.name);
	if (ts.isParenthesizedExpression(p)) return fromRequireUse(p);
	// __importStar(require(...)) / __importDefault(require(...))
	if (ts.isCallExpression(p) && p.arguments.includes(node as ts.Expression)) return fromRequireUse(p);
	return direct(UNRESOLVED);
};

const fromImportDeclaration = (node: ts.ImportDeclaration): Found => {
	const clause = node.importClause;
	if (!clause) return direct(UNRESOLVED);
	const def = clause.name ? binding(clause.name.text) : none;
	const nb = clause.namedBindings;
	if (!nb) return def;
	if (ts.isNamespaceImport(nb)) return concat(def, binding(nb.name.text));
	return concat(def, direct(...nb.elements.map((e) => (e.propertyName ?? e.name).text)));
};

const fromExportDeclaration = (node: ts.ExportDeclaration): Found =>
	node.exportClause && ts.isNamedExports(node.exportClause)
		? direct(...node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text))
		: direct(UNRESOLVED);

const fromImportType = (node: ts.ImportTypeNode): Found => {
	const q = node.qualifier;
	if (!q) return direct(UNRESOLVED);
	const leftmost = (n: ts.EntityName): string => (ts.isIdentifier(n) ? n.text : leftmost(n.left));
	return direct(leftmost(q));
};

const memberAccess = (node: ts.Node): readonly [string, string] | undefined => {
	if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
		return [node.expression.text, node.name.text];
	}
	if (
		ts.isElementAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		ts.isStringLiteralLike(node.argumentExpression)
	) {
		return [node.expression.text, node.argumentExpression.text];
	}
	return undefined;
};

export const symbolsIn = (dep: string, fileName: string, text: string): SymbolCounts => {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
	const found: Found[] = [];
	const accesses: Array<readonly [string, string]> = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && isSpecifier(dep, node.moduleSpecifier)) {
			found.push(fromImportDeclaration(node));
		} else if (ts.isExportDeclaration(node) && isSpecifier(dep, node.moduleSpecifier)) {
			found.push(fromExportDeclaration(node));
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			isSpecifier(dep, node.argument.literal)
		) {
			found.push(fromImportType(node));
		} else if (isRequireOf(dep, node)) {
			found.push(fromRequireUse(node));
		}
		const access = memberAccess(node);
		if (access) accesses.push(access);
		ts.forEachChild(node, visit);
	};
	visit(sf);

	const all = found.reduce(concat, none);
	const resolved = all.bindings.flatMap((b) => {
		const uses = accesses.filter(([obj]) => obj === b).map(([, member]) => member);
		return uses.length ? uses : [UNRESOLVED];
	});
	return tally([...all.direct, ...resolved]);
};

const isRuntimeFile = (p: string) => /\.(c|m)?js$/.test(p);
const isTypesFile = (p: string) => p.endsWith('.d.ts');

const analyzeTarball = (dep: string, tgz: Buffer): Result<Analysis> =>
	attempt('analyze', () => {
		const empty: Analysis = { runtime: {}, types: {} };
		return [...tarEntries(tgz)].reduce<Analysis>((acc, { path, body }) => {
			if (isTypesFile(path)) return { ...acc, types: mergeCounts(acc.types, symbolsIn(dep, path, body.toString())) };
			if (isRuntimeFile(path)) return { ...acc, runtime: mergeCounts(acc.runtime, symbolsIn(dep, path, body.toString())) };
			return acc;
		}, empty);
	});

// ---------------------------------------------------------------- cache

type Cache = {
	readonly read: <T>(kind: string, ref: PackageRef, parse: (b: Buffer) => T) => Promise<T | undefined>;
	readonly write: (kind: string, ref: PackageRef, data: Buffer | string) => Promise<void>;
	readonly list: <T>(kind: string, parse: (b: Buffer) => T) => Promise<readonly T[]>;
};

const makeCache = (dir: string, skip: ReadonlySet<string>): Cache => {
	const safe = ({ name, version }: PackageRef) => `${name.replace('/', '__')}@${version}`;
	const pathFor = (kind: string, ref: PackageRef) => join(dir, kind, safe(ref));
	return {
		read: async (kind, ref, parse) => {
			const p = pathFor(kind, ref);
			return skip.has(kind) || !existsSync(p) ? undefined : parse(await readFile(p));
		},
		write: async (kind, ref, data) => {
			await mkdir(join(dir, kind), { recursive: true });
			await writeFile(pathFor(kind, ref), data);
		},
		list: async (kind, parse) => {
			const d = join(dir, kind);
			if (!existsSync(d)) return [];
			return Promise.all((await readdir(d)).map(async (f) => parse(await readFile(join(d, f)))));
		},
	};
};

// meta and tarballs are dep-independent; analysis results are not.
const resultsKind = (dep: string) => `results/${dep.replace('/', '__')}`;
const skippedCaches = (o: Options): ReadonlySet<string> =>
	new Set(o.refresh ? ['meta', 'tarballs', resultsKind(o.dep)] : o.reanalyze ? [resultsKind(o.dep)] : []);

// ---------------------------------------------------------------- pipeline

type PackageReport = PackageRef & { readonly declared: readonly string[]; readonly analysis: Analysis };

const parseJson = <T>(b: Buffer): T => JSON.parse(b.toString()) as T;
const identity = (b: Buffer) => b;

const depFieldsFor = async (ref: PackageRef, cache: Cache): Promise<Result<DepFields>> => {
	const cached = await cache.read('meta', ref, parseJson<DepFields>);
	if (cached) return ok(cached);
	const manifest = await getJson<Manifest>(`https://registry.npmjs.org/${ref.name}/${ref.version}`);
	if (!manifest.ok) return manifest;
	const fields = depFieldsOf(manifest.value);
	await cache.write('meta', ref, JSON.stringify(fields));
	return ok(fields);
};

const tarballFor = async (ref: PackageRef, cache: Cache): Promise<Result<Buffer>> => {
	const cached = await cache.read('tarballs', ref, identity);
	if (cached) return ok(cached);
	const tgz = await getBuffer(tarballUrl(ref));
	if (tgz.ok) await cache.write('tarballs', ref, tgz.value);
	return tgz;
};

const processPackage = async (ref: PackageRef, opts: Options, cache: Cache): Promise<Result<PackageReport>> => {
	const results = resultsKind(opts.dep);
	const cached = await cache.read(results, ref, parseJson<PackageReport>);
	if (cached) return ok(cached);

	const fields = await depFieldsFor(ref, cache);
	if (!fields.ok) return fields;
	const declared = declaredIn(fields.value, opts.dep);
	const empty: Analysis = { runtime: {}, types: {} };
	const finish = async (analysis: Analysis) => {
		const report: PackageReport = { ...ref, declared, analysis };
		await cache.write(results, ref, JSON.stringify(report));
		return ok(report);
	};
	if (!opts.all && !declared.length) return finish(empty);

	const tgz = await tarballFor(ref, cache);
	if (!tgz.ok) return tgz;
	const analysis = analyzeTarball(opts.dep, tgz.value);
	return analysis.ok ? finish(analysis.value) : analysis;
};

const pool = async <T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>, onDone: (n: number) => void) => {
	const out: R[] = new Array(items.length);
	let next = 0;
	let done = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
			onDone(++done);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
};

// ---------------------------------------------------------------- report

const groupBySymbol = (reports: readonly PackageReport[], key: keyof Analysis) =>
	reports.reduce<Record<string, string[]>>((acc, r) => {
		const id = `${r.name}@${r.version}`;
		return Object.keys(r.analysis[key]).reduce((a, s) => ({ ...a, [s]: [...(a[s] ?? []), id] }), acc);
	}, {});

const report = (all: readonly PackageReport[], errors: readonly string[], opts: Options) => {
	const reports = opts.filter ? all.filter((r) => opts.filter?.test(r.name)) : all;
	const has = (r: PackageReport, k: keyof Analysis) => Object.keys(r.analysis[k]).length > 0;
	const bySymbol = groupBySymbol(reports, 'runtime');
	const typesBySymbol = groupBySymbol(reports, 'types');
	return opts.symbol
		? { symbol: opts.symbol, runtime: bySymbol[opts.symbol] ?? [], types: typesBySymbol[opts.symbol] ?? [] }
		: {
				dep: opts.dep,
				scanned: reports.length,
				declaring: reports.filter((r) => r.declared.length).length,
				runtimeImporters: reports.filter((r) => has(r, 'runtime')).length,
				typeOnlyImporters: reports.filter((r) => !has(r, 'runtime') && has(r, 'types')).length,
				bySymbol,
				typesBySymbol,
				errors,
			};
};

// ---------------------------------------------------------------- selftest

const FIXTURES: ReadonlyArray<readonly [string, string, SymbolCounts]> = [
	['tsc.js', 'const n8n_core_1 = require("n8n-core"); n8n_core_1.Cipher; n8n_core_1.BINARY_ENCODING;', { Cipher: 1, BINARY_ENCODING: 1 }],
	['star.js', 'const core = __importStar(require("n8n-core")); core.InstanceSettings;', { InstanceSettings: 1 }],
	['destructure.js', 'const { Cipher, ErrorReporter: ER } = require("n8n-core");', { Cipher: 1, ErrorReporter: 1 }],
	['inline.js', 'x = require("n8n-core").BINARY_ENCODING; y = require("n8n-core")["Cipher"];', { BINARY_ENCODING: 1, Cipher: 1 }],
	['esbuild.js', 'var import_n8n_core = require("n8n-core"); import_n8n_core.BINARY_ENCODING', { BINARY_ENCODING: 1 }],
	['ns.mjs', 'import * as core from "n8n-core"; core.Cipher', { Cipher: 1 }],
	['named.mjs', 'import { Cipher, type Foo, Bar as Baz } from "n8n-core"', { Cipher: 1, Foo: 1, Bar: 1 }],
	['reexport.mjs', 'export { Cipher } from "n8n-core"', { Cipher: 1 }],
	['unresolved.js', 'const core = require("n8n-core"); doStuff(core)', { '*': 1 }],
	['other.js', 'const w = require("n8n-workflow"); w.Cipher', {}],
	['string.js', 'const s = "require(\\"n8n-core\\").Cipher"; // n8n_core_1.Cipher', {}],
	['inline.d.ts', 'declare const x: import("n8n-core").IExecuteFunctions;', { IExecuteFunctions: 1 }],
	['named.d.ts', 'import type { IExecuteFunctions, IHookFunctions } from "n8n-core";', { IExecuteFunctions: 1, IHookFunctions: 1 }],
];

const selftest = (): number => {
	const failures = FIXTURES.filter(([file, src, expected]) => {
		const actual = symbolsIn('n8n-core', file, src);
		const same = JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(expected).sort());
		if (!same) console.error(`FAIL ${file}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
		return !same;
	});
	console.error(`${FIXTURES.length - failures.length}/${FIXTURES.length} fixtures pass`);
	return failures.length ? 1 : 0;
};

// ---------------------------------------------------------------- main

const scan = async (opts: Options, cache: Cache): Promise<number> => {
	const pkgs = await listPackages(opts);
	if (!pkgs.ok) {
		console.error(pkgs.error);
		return 1;
	}
	console.error(`inspecting ${pkgs.value.length} packages for ${opts.dep} (${opts.all ? 'all' : 'declaring only'})`);
	const t0 = Date.now();
	const results = await pool(
		pkgs.value,
		opts.concurrency,
		(ref) => processPackage(ref, opts, cache),
		(n) => n % 250 === 0 && console.error(`${n}/${pkgs.value.length}`),
	);
	console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
	const reports = results.flatMap((r) => (r.ok ? [r.value] : []));
	const errors = results.flatMap((r) => (r.ok ? [] : [r.error]));
	console.log(JSON.stringify(report(reports, errors, opts), null, 2));
	return 0;
};

const reportOnly = async (opts: Options, cache: Cache): Promise<number> => {
	const reports = await cache.list(resultsKind(opts.dep), parseJson<PackageReport>);
	if (!reports.length) {
		console.error(`no cached results for ${opts.dep}; run scan first`);
		return 1;
	}
	console.log(JSON.stringify(report(reports, [], opts), null, 2));
	return 0;
};

const main = async (): Promise<number> => {
	const parsed = parseArgs(process.argv.slice(2));
	if (!parsed.ok) {
		console.error(parsed.error);
		return 2;
	}
	const opts = parsed.value;
	const cache = makeCache(opts.cacheDir, skippedCaches(opts));
	switch (opts.command) {
		case 'selftest':
			return selftest();
		case 'scan':
			return scan(opts, cache);
		case 'report':
			return reportOnly(opts, cache);
	}
};

if (import.meta.main) process.exit(await main());
