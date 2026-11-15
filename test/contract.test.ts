/**
 * Each tool's request fits the dated OpenAPI copy in `openapi/`: the host, the method and path,
 * the query names, the body names (one level, and `request` of a preview), and the enum values.
 */
import { afterAll, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contextFromEnv } from '../src/main.ts';
import { runTool, TOOLS } from '../src/tools.ts';
import { MARKET_SLUG, makeTestKey, type RecordedRequest, startFakePolymarketUs } from './fake-polymarket-us.ts';

type Json = Record<string, unknown>;
interface Operation {
	host: 'api' | 'gateway';
	method: string;
	pattern: RegExp;
	template: string;
	params: Set<string>;
	body: Json | null;
	schemas: Record<string, Json>;
}

const dir = join(import.meta.dir, '..', 'openapi');
const operations: Operation[] = [];
for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
	const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Json;
	const server = ((doc.servers as Json[])[0]?.url as string) ?? '';
	const host = server.includes('gateway') ? 'gateway' : 'api';
	const schemas = ((doc.components as Json)?.schemas ?? {}) as Record<string, Json>;
	for (const [template, ops] of Object.entries(doc.paths as Record<string, Json>)) {
		for (const [method, op] of Object.entries(ops)) {
			const operation = op as Json;
			const params = new Set(((operation.parameters as Json[]) ?? []).map((p) => p.name as string));
			const content = ((operation.requestBody as Json)?.content as Json)?.['application/json'] as Json | undefined;
			operations.push({
				host,
				method: method.toUpperCase(),
				template,
				pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`),
				params,
				body: (content?.schema as Json) ?? null,
				schemas,
			});
		}
	}
}

const resolve = (schema: Json, schemas: Record<string, Json>): Json =>
	typeof schema.$ref === 'string' ? (schemas[schema.$ref.split('/').at(-1) ?? ''] ?? {}) : schema;

function checkBody(body: Json, schema: Json, schemas: Record<string, Json>, where: string): string[] {
	const problems: string[] = [];
	const resolved = resolve(schema, schemas);
	const properties = (resolved.properties ?? {}) as Record<string, Json>;
	for (const required of (resolved.required as string[]) ?? []) {
		if (!(required in body)) problems.push(`${where}: missing ${required}`);
	}
	for (const [name, value] of Object.entries(body)) {
		const property = properties[name];
		if (!property) {
			problems.push(`${where}: unknown field ${name}`);
			continue;
		}
		const target = resolve(property, schemas);
		if (Array.isArray(target.enum) && !target.enum.includes(value)) {
			problems.push(`${where}.${name}: ${String(value)} is not in the enum`);
		}
		if (target.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
			problems.push(...checkBody(value as Json, target, schemas, `${where}.${name}`));
		}
	}
	return problems;
}

function match(request: RecordedRequest): string[] {
	const operation = operations.find(
		(op) => op.host === request.host && op.method === request.method && op.pattern.test(request.path),
	);
	if (!operation) return [`no operation for ${request.host} ${request.method} ${request.path}`];
	const problems: string[] = [];
	for (const name of Object.keys(request.query)) {
		if (!operation.params.has(name)) problems.push(`${operation.template}: unknown query ${name}`);
	}
	if (request.body) {
		if (!operation.body) problems.push(`${operation.template}: sends a body it does not take`);
		else problems.push(...checkBody(request.body, operation.body, operation.schemas, operation.template));
	}
	return problems;
}

const key = await makeTestKey();
const fake = startFakePolymarketUs({ key });
afterAll(() => fake.stop());

test('each tool request fits the dated OpenAPI copy', async () => {
	const { context } = await contextFromEnv({
		POLYMARKET_US_API_URL: fake.apiUrl,
		POLYMARKET_US_GATEWAY_URL: fake.gatewayUrl,
		POLYMARKET_KEY_ID: key.keyId,
		POLYMARKET_SECRET_KEY: key.secretKey,
	});
	const order = { market_slug: MARKET_SLUG, intent: 'BUY_LONG', type: 'LIMIT', quantity: 2, price: '0.4' };
	const inputs: Record<string, Json> = {
		search_markets: { query: 'fed', limit: 5, page: 1, markets_per_event: 2, detail: 'full' },
		get_market: { market_slug: MARKET_SLUG },
		get_order_book: { market_slug: MARKET_SLUG },
		get_price_history: { market_slug: MARKET_SLUG, interval: '1W' },
		get_balances: {},
		get_positions: { market_slug: MARKET_SLUG, limit: 10, cursor: 'c1' },
		get_activities: { market_slug: MARKET_SLUG, limit: 10, cursor: 'c1' },
		get_open_orders: { market_slug: MARKET_SLUG },
		preview_order: { ...order, tif: 'GTD', good_till_time: '2026-12-01T00:00:00Z' },
		place_order: order,
		get_order: { order_id: 'ord-1' },
		modify_order: { order_id: 'ord-1', market_slug: MARKET_SLUG, price: '0.41', quantity: 2, tif: 'IOC' },
		cancel_order: { order_id: 'ord-1', market_slug: MARKET_SLUG },
		cancel_all_orders: { market_slug: MARKET_SLUG },
		close_position: { market_slug: MARKET_SLUG },
	};
	expect(Object.keys(inputs).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
	for (const [name, input] of Object.entries(inputs)) await runTool(name, input, context);
	// A custom range goes with no fixed interval; the vendor refuses both together.
	await runTool('get_price_history', { market_slug: MARKET_SLUG, start: 1_794_700_000, end: 1_794_703_600 }, context);
	const problems = fake.requests.flatMap(match);
	expect(problems).toEqual([]);
	expect(fake.requests.length).toBeGreaterThanOrEqual(16);
});
