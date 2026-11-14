/**
 * The release file over stdio, as Roost runs it: build the one bundled file, start it with Bun and
 * a plain environment, and talk to it with the official MCP client.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { type FakePolymarketUs, MARKET_SLUG, makeTestKey, startFakePolymarketUs, type TestKey } from './fake-polymarket-us.ts';

let dir = '';
let bundle = '';
let key: TestKey;
let fake: FakePolymarketUs;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'pmus-bundle-'));
	const built = await Bun.build({
		entrypoints: [join(import.meta.dir, '..', 'src', 'main.ts')],
		target: 'bun',
		outdir: dir,
		naming: 'roost-mcp-polymarket-us.js',
	});
	expect(built.success).toBe(true);
	bundle = join(dir, 'roost-mcp-polymarket-us.js');
	key = await makeTestKey();
	fake = startFakePolymarketUs({ key });
});

afterAll(() => {
	fake?.stop();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function connect(env: Record<string, string>): Promise<{ client: Client; stderr: () => string }> {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [bundle],
		env: { PATH: process.env.PATH ?? '', ...env },
		stderr: 'pipe',
	});
	let tail = '';
	transport.stderr?.on('data', (chunk: Buffer) => {
		tail += chunk.toString('utf8');
	});
	const client = new Client({ name: 'test', version: '1' });
	await client.connect(transport);
	return { client, stderr: () => tail };
}

test('the bundle lists 15 tools and answers reads and an order over stdio', async () => {
	const { client, stderr } = await connect({
		POLYMARKET_US_API_URL: fake.apiUrl,
		POLYMARKET_US_GATEWAY_URL: fake.gatewayUrl,
		POLYMARKET_KEY_ID: key.keyId,
		POLYMARKET_SECRET_KEY: key.secretKey,
	});
	try {
		expect(client.getServerVersion()?.name).toBe('roost-mcp-polymarket-us');
		const { tools } = await client.listTools();
		expect(tools.length).toBe(15);
		expect(tools.find((tool) => tool.name === 'place_order')?.annotations?.readOnlyHint).toBe(false);
		expect(tools.find((tool) => tool.name === 'get_positions')?.annotations?.readOnlyHint).toBe(true);
		const positions = await client.callTool({ name: 'get_positions', arguments: {} });
		expect(positions.isError).toBeFalsy();
		expect(Object.keys((positions.structuredContent as { positions: object }).positions)).toEqual([MARKET_SLUG]);
		const placed = await client.callTool({
			name: 'place_order',
			arguments: { market_slug: MARKET_SLUG, intent: 'BUY_LONG', type: 'LIMIT', quantity: 1, price: '0.4' },
		});
		expect((placed.structuredContent as { orderId: string }).orderId).toBe('ord-1');
		const over = await client.callTool({
			name: 'place_order',
			arguments: { market_slug: MARKET_SLUG, intent: 'BUY_LONG', type: 'LIMIT', quantity: 1000, price: '0.4' },
		});
		expect(over.isError).toBe(true);
		expect((over.structuredContent as { error: { class: string } }).error.class).toBe('denied');
		expect(stderr()).not.toContain(key.secretKey);
	} finally {
		await client.close();
	}
});

test('with no key the public tools work and an account tool says to add the key', async () => {
	const { client } = await connect({
		POLYMARKET_US_API_URL: fake.apiUrl,
		POLYMARKET_US_GATEWAY_URL: fake.gatewayUrl,
	});
	try {
		const search = await client.callTool({ name: 'search_markets', arguments: { query: 'fed' } });
		expect(search.isError).toBeFalsy();
		const balances = await client.callTool({ name: 'get_balances', arguments: {} });
		expect(balances.isError).toBe(true);
		expect(JSON.stringify(balances.content)).toContain('Add your Polymarket US key on the app page.');
	} finally {
		await client.close();
	}
});
