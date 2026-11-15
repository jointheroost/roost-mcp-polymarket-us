/**
 * Version 0.1.1: one argument name for a market, small answers by default, plain cost fields, and
 * a price history request that the vendor accepts. The fake vendor answers with real-sized bodies.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ToolError } from '../src/errors.ts';
import { contextFromEnv } from '../src/main.ts';
import { toolList } from '../src/mcp.ts';
import { runTool, TOOLS, type ToolContext } from '../src/tools.ts';
import {
	type FakePolymarketUs,
	MARKET_SLUG,
	makeTestKey,
	startFakePolymarketUs,
} from './fake-polymarket-us.ts';

let fake: FakePolymarketUs | null = null;
afterEach(() => {
	fake?.stop();
	fake = null;
});

async function setUp(): Promise<{ context: ToolContext; fake: FakePolymarketUs }> {
	const key = await makeTestKey();
	fake = startFakePolymarketUs({ key });
	const { context } = await contextFromEnv(
		{
			POLYMARKET_US_API_URL: fake.apiUrl,
			POLYMARKET_US_GATEWAY_URL: fake.gatewayUrl,
			POLYMARKET_KEY_ID: key.keyId,
			POLYMARKET_SECRET_KEY: key.secretKey,
		},
		{ sleep: async () => {} },
	);
	return { context, fake };
}

async function failure(promise: Promise<unknown>): Promise<ToolError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ToolError) return error;
		throw error;
	}
	throw new Error('expected a ToolError');
}

const size = (value: unknown) => JSON.stringify(value).length;

describe('one name for a market', () => {
	const marketTools = TOOLS.filter((tool) => 'market_slug' in tool.inputSchema.properties || 'slug' in tool.inputSchema.properties);

	test('no tool takes `slug`; every tool that takes a market takes `market_slug`', () => {
		expect(marketTools.map((tool) => tool.name).sort()).toEqual(
			[
				'cancel_all_orders',
				'cancel_order',
				'close_position',
				'get_activities',
				'get_market',
				'get_open_orders',
				'get_order_book',
				'get_positions',
				'get_price_history',
				'modify_order',
				'place_order',
				'preview_order',
			].sort(),
		);
		for (const tool of TOOLS) {
			expect(Object.keys(tool.inputSchema.properties)).not.toContain('slug');
			expect(Object.keys(tool.inputSchema.properties).filter((name) => name.includes('slug'))).toEqual(
				marketTools.includes(tool) ? ['market_slug'] : [],
			);
		}
	});

	test('the three tools that needed `slug` work with market_slug', async () => {
		const { context } = await setUp();
		expect((await runTool('get_market', { market_slug: MARKET_SLUG }, context)).market).toBeDefined();
		expect((await runTool('get_order_book', { market_slug: MARKET_SLUG }, context)).marketData).toBeDefined();
		expect((await runTool('get_price_history', { market_slug: MARKET_SLUG }, context)).history).toBeDefined();
	});

	test('a missing market_slug is an error that names market_slug and says where to get it', async () => {
		const { context, fake } = await setUp();
		for (const name of ['get_market', 'get_order_book', 'get_price_history']) {
			const error = await failure(runTool(name, {}, context));
			expect(error.message).toBe('market_slug is required. Get it from search_markets.');
			// The old name does not work and the error still names the right one.
			const old = await failure(runTool(name, { slug: MARKET_SLUG }, context));
			expect(old.message).toContain('market_slug is required.');
		}
		expect(fake.requests.length).toBe(0);
	});

	test('a wrong extra argument names the arguments that the tool takes', async () => {
		const { context } = await setUp();
		const error = await failure(runTool('get_market', { market_slug: MARKET_SLUG, slug: 'x' }, context));
		expect(error.message).toContain('Unknown input "slug"');
		expect(error.message).toContain('market_slug');
	});

	test('the same thing has the same name in every tool', () => {
		const names = (tool: string) => Object.keys(TOOLS.find((item) => item.name === tool)?.inputSchema.properties ?? {});
		for (const tool of ['get_order', 'modify_order', 'cancel_order']) expect(names(tool)).toContain('order_id');
		for (const tool of ['get_positions', 'get_activities']) {
			expect(names(tool)).toContain('limit');
			expect(names(tool)).toContain('cursor');
		}
		for (const tool of TOOLS) {
			for (const name of names(tool.name)) expect(['id', 'orderId', 'order', 'market', 'slugs', 'next']).not.toContain(name);
		}
	});

	test('each tool description is short and names market_slug where the tool takes one', () => {
		for (const tool of TOOLS) {
			expect(tool.description.length).toBeLessThanOrEqual(330);
			if ('market_slug' in tool.inputSchema.properties) {
				const property = tool.inputSchema.properties.market_slug;
				expect(`${tool.description} ${property?.description}`).toContain('market_slug');
			}
		}
		const listed = toolList();
		// No extra keyword in the schema that a model provider could refuse.
		expect(JSON.stringify(listed)).not.toContain('"hint"');
	});
});

describe('small answers by default', () => {
	test('search_markets with limit 3 is under 4 KB; detail "full" gives the whole answer', async () => {
		const { context, fake } = await setUp();
		const compact = await runTool('search_markets', { query: 'fed', limit: 3 }, context);
		expect(size(compact)).toBeLessThan(4_000);
		const full = await runTool('search_markets', { query: 'fed', limit: 3, detail: 'full' }, context);
		expect(size(full)).toBeGreaterThan(60_000);
		expect((full.events as { markets: unknown[] }[])[0]?.markets.length).toBe(12);
		expect(fake.requests.length).toBe(2);
		// The compact answer keeps what a bot needs to answer and to call the next tool.
		const events = compact.events as Record<string, unknown>[];
		expect(events.length).toBe(3);
		expect(Object.keys(events[0] ?? {})).toEqual(
			expect.arrayContaining(['id', 'slug', 'title', 'state', 'endDate', 'volume', 'marketCount', 'markets']),
		);
		const first = (events[0]?.markets as Record<string, unknown>[])[0];
		expect(first).toMatchObject({ slug: 'fed-event-1-m0', title: 'Option 0', state: 'OPEN', yesPrice: '0.3000', noPrice: '0.7000' });
		expect(first?.endDate).toBe('2026-12-31T04:59:00Z');
		expect(events[0]?.marketCount).toBe(12);
		expect((events[0]?.markets as unknown[]).length).toBe(3);
		const text = JSON.stringify(compact);
		expect(text).not.toContain('https://');
		expect(text).not.toContain('resolves to Yes');
		expect(text).not.toContain('marketSides');
	});

	test('search_markets markets_per_event shows more markets of each event', async () => {
		const { context } = await setUp();
		const answer = await runTool('search_markets', { query: 'fed', limit: 1, markets_per_event: 12 }, context);
		expect(((answer.events as { markets: unknown[] }[])[0]?.markets ?? []).length).toBe(12);
	});

	test('get_market is compact, with detail "full" it is the whole answer', async () => {
		const { context } = await setUp();
		const compact = await runTool('get_market', { market_slug: MARKET_SLUG }, context);
		expect(compact.market).toMatchObject({
			slug: MARKET_SLUG,
			question: 'Will the Fed cut rates in December?',
			state: 'OPEN',
			yesPrice: '0.4200',
			noPrice: '0.5800',
			endDate: '2026-12-31T04:59:00Z',
		});
		expect(size(compact)).toBeLessThan(1_000);
		const full = await runTool('get_market', { market_slug: MARKET_SLUG, detail: 'full' }, context);
		expect(size(full)).toBeGreaterThan(1_800);
		expect((full.market as { rulesDisclaimer: string }).rulesDisclaimer).toContain('resolves to Yes');
	});

	test('get_activities with limit 5 is under 3 KB; detail "full" gives the whole answer', async () => {
		const { context } = await setUp();
		const compact = await runTool('get_activities', { limit: 5 }, context);
		expect(size(compact)).toBeLessThan(3_000);
		const rows = compact.activities as Record<string, unknown>[];
		expect(rows.length).toBe(5);
		expect(rows[0]).toMatchObject({
			type: 'TRADE',
			tradeId: 'trade-1',
			marketSlug: MARKET_SLUG,
			state: 'CLEARED',
			time: '2026-11-13T21:44:12.654321Z',
			price: '0.4000',
			quantity: '5',
			costBasisUsd: '2.05',
			realizedPnlUsd: '0',
		});
		expect(compact.nextCursor).toBe('next-page');
		expect(compact.eof).toBe(false);
		expect(JSON.stringify(compact)).not.toContain('rulesDisclaimer');
		const full = await runTool('get_activities', { limit: 5, detail: 'full' }, context);
		expect(size(full)).toBeGreaterThan(10_000);
		expect(JSON.stringify(full)).toContain('rulesDisclaimer');
	});

	test('get_positions names the cost fields plainly and keeps the vendor values', async () => {
		const { context } = await setUp();
		const compact = await runTool('get_positions', { market_slug: MARKET_SLUG }, context);
		expect(compact.positions).toEqual([
			{
				marketSlug: MARKET_SLUG,
				title: 'December cut',
				outcome: 'Yes',
				side: 'LONG',
				quantity: '20',
				costBasisUsd: '8.00',
				avgPrice: '0.4',
				realizedPnlUsd: '0',
				unrealizedPnlUsd: '0.40',
				quantityAvailable: '20',
				expired: false,
				updatedAt: '2026-11-13T21:44:12.654321Z',
			},
		]);
		expect(compact.eof).toBe(true);
		expect(JSON.stringify(compact)).not.toContain('https://');
		const full = await runTool('get_positions', { market_slug: MARKET_SLUG, detail: 'full' }, context);
		expect(Object.keys(full.positions as object)).toEqual([MARKET_SLUG]);
	});

	test('a short position shows side SHORT and a positive quantity', async () => {
		const key = await makeTestKey();
		fake = startFakePolymarketUs({ key, netPosition: '-4' });
		const { context } = await contextFromEnv({
			POLYMARKET_US_API_URL: fake.apiUrl,
			POLYMARKET_US_GATEWAY_URL: fake.gatewayUrl,
			POLYMARKET_KEY_ID: key.keyId,
			POLYMARKET_SECRET_KEY: key.secretKey,
		});
		const answer = await runTool('get_positions', {}, context);
		expect(answer.positions).toMatchObject([{ side: 'SHORT', quantity: '4', costBasisUsd: '8.00', avgPrice: '2' }]);
	});

	test('get_open_orders is compact; detail "full" is the whole answer', async () => {
		const { context } = await setUp();
		await runTool(
			'place_order',
			{ market_slug: MARKET_SLUG, intent: 'BUY_LONG', type: 'LIMIT', quantity: 10, price: '0.45' },
			context,
		);
		const compact = await runTool('get_open_orders', { market_slug: MARKET_SLUG }, context);
		expect(compact.orders).toMatchObject([
			{ orderId: 'ord-1', marketSlug: MARKET_SLUG, intent: 'BUY_LONG', state: 'NEW', quantity: 10, filledQuantity: 0, remainingQuantity: 10 },
		]);
		expect(JSON.stringify(compact)).not.toContain('commissionsBasisPoints');
		const full = await runTool('get_open_orders', { market_slug: MARKET_SLUG, detail: 'full' }, context);
		expect(JSON.stringify(full)).toContain('commissionsBasisPoints');
	});

	test('detail takes compact or full, in any case, and nothing else', async () => {
		const { context } = await setUp();
		const upper = await runTool('get_market', { market_slug: MARKET_SLUG, detail: 'FULL' }, context);
		expect((upper.market as { rulesDisclaimer?: string }).rulesDisclaimer).toBeDefined();
		const error = await failure(runTool('get_market', { market_slug: MARKET_SLUG, detail: 'big' }, context));
		expect(error.message).toBe('detail must be one of compact, full.');
		for (const name of ['search_markets', 'get_market', 'get_activities', 'get_positions', 'get_open_orders']) {
			expect(Object.keys(TOOLS.find((tool) => tool.name === name)?.inputSchema.properties ?? {})).toContain('detail');
		}
	});
});

describe('get_price_history', () => {
	test('a fixed interval sends its documented fidelity and no timestamps', async () => {
		const { context, fake } = await setUp();
		for (const [interval, fidelity] of [['1H', '1'], ['1D', '5'], ['1W', '180'], ['ALL', '180'], ['LIVE', '1']] as const) {
			await runTool('get_price_history', { market_slug: MARKET_SLUG, interval }, context);
			const request = fake.requests.at(-1);
			expect(request?.path).toBe('/v1/price-history');
			expect(request?.query).toEqual({ symbol: [MARKET_SLUG], fixedInterval: [`INTERVAL_${interval}`], fidelity: [fidelity] });
		}
	});

	test('with no interval it asks for the last day; a custom range sends fidelity 1 and no interval', async () => {
		const { context, fake } = await setUp();
		await runTool('get_price_history', { market_slug: MARKET_SLUG }, context);
		expect(fake.requests.at(-1)?.query.fixedInterval).toEqual(['INTERVAL_1D']);
		const answer = await runTool('get_price_history', { market_slug: MARKET_SLUG, start: 1_794_700_000, end: 1_794_703_600 }, context);
		expect(fake.requests.at(-1)?.query).toEqual({
			symbol: [MARKET_SLUG],
			fidelity: ['1'],
			'timestamp.startTimestamp': ['1794700000'],
			'timestamp.endTimestamp': ['1794703600'],
		});
		expect(answer.points).toBe(60);
	});

	test('a range with an interval, or half a range, is refused here with a plain message', async () => {
		const { context, fake } = await setUp();
		const both = await failure(runTool('get_price_history', { market_slug: MARKET_SLUG, interval: '1D', start: 1, end: 2 }, context));
		expect(both.message).toBe('Give interval, or start and end, not both.');
		const half = await failure(runTool('get_price_history', { market_slug: MARKET_SLUG, start: 1 }, context));
		expect(half.message).toBe('start and end go together. Give both, or neither.');
		expect(fake.requests.length).toBe(0);
	});

	test('the compact answer is thinned to at most 48 points and keeps the first and the last', async () => {
		const { context } = await setUp();
		const compact = await runTool('get_price_history', { market_slug: MARKET_SLUG, interval: '1D' }, context);
		expect(compact.points).toBe(288);
		const history = compact.history as { t: number; yes: number; no: number }[];
		expect(history.length).toBe(48);
		expect(history[0]).toEqual({ t: 1_794_613_600, yes: 0.4, no: 0.6 });
		expect(history.at(-1)?.t).toBe(1_794_613_600 + 287 * 300);
		expect(size(compact)).toBeLessThan(3_000);
		const full = await runTool('get_price_history', { market_slug: MARKET_SLUG, interval: '1D', detail: 'full' }, context);
		expect((full.history as unknown[]).length).toBe(288);
		expect(Object.keys((full.history as object[])[0] ?? {})).toEqual(['timestamp', 'longPrice', 'shortPrice']);
	});

	test('an unknown market gives an empty history and a note that says what to do', async () => {
		const { context } = await setUp();
		const answer = await runTool('get_price_history', { market_slug: 'no-such-market' }, context);
		expect(answer.history).toEqual([]);
		expect(answer.note).toBe('Polymarket US has no price history for this market_slug. Check it with get_market.');
	});
});
