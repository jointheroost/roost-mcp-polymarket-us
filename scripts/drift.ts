/**
 * The drift check: read the vendor's public OpenAPI files (no key) and compare them with the dated
 * copies in `openapi/`. It reports each operation, query name, and body field that changed, and
 * exits with 1 when something changed. `--write` replaces the copies (then update SOURCE.md).
 *
 *   bun scripts/drift.ts           compare
 *   bun scripts/drift.ts --write   take the new files
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://docs.polymarket.us/api-reference/oapi-schemas/';
const dir = join(import.meta.dir, '..', 'openapi');
type Json = Record<string, unknown>;

/** One line for each operation, query name, and body field. Pure. */
export function surface(doc: Json): Set<string> {
	const lines = new Set<string>();
	const schemas = ((doc.components as Json)?.schemas ?? {}) as Record<string, Json>;
	const fields = (schema: Json | undefined, prefix: string, depth: number) => {
		if (!schema || depth > 2) return;
		const resolved =
			typeof schema.$ref === 'string' ? schemas[schema.$ref.split('/').at(-1) ?? ''] : schema;
		if (!resolved) return;
		if (Array.isArray(resolved.enum)) lines.add(`${prefix} enum ${[...resolved.enum].sort().join('|')}`);
		for (const [name, value] of Object.entries((resolved.properties ?? {}) as Record<string, Json>)) {
			lines.add(`${prefix}.${name}`);
			fields(value, `${prefix}.${name}`, depth + 1);
		}
	};
	for (const [path, ops] of Object.entries((doc.paths ?? {}) as Record<string, Json>)) {
		for (const [method, op] of Object.entries(ops)) {
			const operation = op as Json;
			const id = `${method.toUpperCase()} ${path}`;
			lines.add(id);
			for (const param of (operation.parameters as Json[]) ?? []) lines.add(`${id} ?${param.name}`);
			const body = ((operation.requestBody as Json)?.content as Json)?.['application/json'] as Json | undefined;
			fields(body?.schema as Json | undefined, `${id} body`, 0);
		}
	}
	return lines;
}

if (import.meta.main) {
	const write = process.argv.includes('--write');
	let changed = 0;
	for (const file of readdirSync(dir).filter((name) => name.endsWith('.json')).sort()) {
		const response = await fetch(`${BASE}${file}`, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			console.log(`${file}: the vendor answered ${response.status}. Check the docs index.`);
			changed++;
			continue;
		}
		const text = await response.text();
		const before = surface(JSON.parse(readFileSync(join(dir, file), 'utf8')) as Json);
		const after = surface(JSON.parse(text) as Json);
		const added = [...after].filter((line) => !before.has(line));
		const removed = [...before].filter((line) => !after.has(line));
		if (added.length === 0 && removed.length === 0) {
			console.log(`${file}: no change`);
			continue;
		}
		changed++;
		console.log(`${file}: changed`);
		for (const line of added) console.log(`  + ${line}`);
		for (const line of removed) console.log(`  - ${line}`);
		if (write) writeFileSync(join(dir, file), text);
	}
	if (changed > 0 && !write) {
		console.log('The vendor API changed. Read the changelog, fix the tools, then run with --write.');
		process.exit(1);
	}
}
