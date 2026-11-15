import { afterEach, describe, expect, test } from 'bun:test';
import { ToolError } from '../src/errors.ts';
import { contextFromEnv } from '../src/main.ts';
import { handleMessage, toolList } from '../src/mcp.ts';
import { MONEY_TOOLS, runTool, TOOLS, type ToolContext } from '../src/tools.ts';
import {
	type FakePolymarketUs,
	MARKET_SLUG,
	makeTestKey,
	startFakePolymarketUs,
	type TestKey,
} from './fake-polymarket-us.ts';

let fake: FakePolymarketUs | null = null;
afterEach(() => {
	fake?.stop();
	fake = null;
});

async function setUp(
	options: {
		withKey?: boolean;
		env?: Record<string, string>;
		clockOffsetMs?: number;
		fake?: Partial<Parameters<typeof startFakePolymarketUs>[0]>;
	} = {},
): Promise<{ context: ToolContext; key: TestKey; fake: FakePolymarketUs; slept: number[]; secrets: string[] }> {
	const key = await makeTestKey();
	fake = startFakePolymarketUs({ key, ...options.fake });
	const slept: number[] = [];
	const { context, secrets } = await contextFromEnv(
		{
			POLYMARKET_US_API_URL: fake.apiUrl,
			POLYMARKET_US_GATEWAY_URL: fake.gatewayUrl,
			...(options.withKey === false
				? {}
				: { POLYMARKET_KEY_ID: key.keyId, POLYMARKET_SECRET_KEY: key.secretKey }),
			...options.env,
		},
		{
			now: () => Date.now() + (options.clockOffsetMs ?? 0),
			sleep: async (ms) => {
				slept.push(ms);
			},
		},
	);
	return { context, key, fake, slept, secrets };
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

const order = {
	market_slug: MARKET_SLUG,
	intent: 'BUY_LONG',
	type: 'LIMIT',
	quantity: 10,
	price: '0.45',
};

describe('the tool list', () => {
	test('has the read tools with readOnlyHint and the five money tools without it', () => {
		const list = toolList();
		const read = list.filter((tool) => (tool.annotations as { readOnlyHint: boolean }).readOnlyHint);
		expect(read.map((tool) => tool.name).sort()).toEqual(
			[
				'get_activities',
				'get_balances',
				'get_market',
				'get_open_orders',
				'get_order',
				'get_order_book',
				'get_positions',
				'get_price_history',
				'preview_order',
				'search_markets',
			].sort(),
		);
		expect(TOOLS.filter((tool) => tool.money).map((tool) => tool.name)).toEqual([...MONEY_TOOLS]);
		expect(TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name)).toEqual([...MONEY_TOOLS]);
	});
});

describe('with no key', () => {
	test('the four public tools work and go to the gateway with no signature', async () => {
		const { context, fake } = await setUp({ withKey: false });
		await runTool('search_markets', { query: 'fed' }, context);
		await runTool('get_market', { market_slug: MARKET_SLUG }, context);
		await runTool('get_order_book', { market_slug: MARKET_SLUG }, context);
		const history = await runTool('get_price_history', { market_slug: MARKET_SLUG }, context);
		expect(history.history).toBeDefined();
		expect(fake.requests.every((request) => request.host === 'gateway')).toBe(true);
		expect(fake.requests.some((request) => request.headers['x-pm-signature'])).toBe(false);
	});

	test('an account tool says to add the key and sends nothing', async () => {
		const { context, fake } = await setUp({ withKey: false });
		const error = await failure(runTool('get_positions', {}, context));
		expect(error.errorClass).toBe('auth');
		expect(error.message).toContain('Add your Polymarket US key on the app page.');
		expect(fake.requests.length).toBe(0);
	});
});

describe('with the key', () => {
	test('read tools send the three headers and the fake vendor accepts the signature', async () => {
		const { context, fake } = await setUp();
		const balances = await runTool('get_balances', {}, context);
		expect(balances.balances).toEqual([{ currentBalance: 125.5, currency: 'USD', buyingPower: 100.25 }]);
		const positions = await runTool('get_positions', { market_slug: MARKET_SLUG }, context);
		expect((positions.positions as { marketSlug: string }[]).map((item) => item.marketSlug)).toEqual([MARKET_SLUG]);
		await runTool('get_activities', { limit: 5 }, context);
		await runTool('get_open_orders', { market_slug: MARKET_SLUG }, context);
		const preview = await runTool('preview_order', order, context);
		expect((preview.order as { state: string }).state).toBe('ORDER_STATE_PREVIEW');
		const signed = fake.requests.filter((request) => request.host === 'api');
		expect(signed.length).toBe(5);
		for (const request of signed) {
			expect(request.headers['x-pm-access-key']).toBe('pmus-test-key-0001');
			expect(request.headers['x-pm-timestamp']).toMatch(/^\d{13}$/);
			expect(request.headers['x-pm-signature']).toBeTruthy();
		}
		// The signature covers the path only: the query string is not signed (SDK 0.1.1).
		expect(signed.find((r) => r.path === '/v1/portfolio/positions')?.query.market).toEqual([MARKET_SLUG]);
	});

	test('place_order sends the order, marked as sent by a program, and cancel_order cancels it', async () => {
		const { context, fake } = await setUp();
		const placed = await runTool('place_order', order, context);
		expect(placed.orderId).toBe('ord-1');
		expect(placed.estimatedNotionalUsd).toBe('4.5');
		expect(placed.capUsd).toBe('50');
		const sent = fake.requests.find((r) => r.path === '/v1/orders');
		expect(sent?.body).toEqual({
			marketSlug: MARKET_SLUG,
			intent: 'ORDER_INTENT_BUY_LONG',
			type: 'ORDER_TYPE_LIMIT',
			quantity: 10,
			tif: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
			price: { value: '0.45', currency: 'USD' },
			manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
		});
		const open = await runTool('get_open_orders', {}, context);
		expect((open.orders as unknown[]).length).toBe(1);
		const canceled = await runTool('cancel_order', { order_id: 'ord-1', market_slug: MARKET_SLUG }, context);
		expect(canceled.canceled).toBe(true);
		expect(fake.openOrders.size).toBe(0);
		expect(fake.requests.find((r) => r.path === '/v1/order/ord-1/cancel')?.body).toEqual({ marketSlug: MARKET_SLUG });
	});

	test('cancel_all_orders cancels every open order, or the orders of one market', async () => {
		const { context, fake } = await setUp();
		await runTool('place_order', order, context);
		await runTool('place_order', order, context);
		const answer = await runTool('cancel_all_orders', {}, context);
		expect(answer.canceledOrderIds).toEqual(['ord-1', 'ord-2']);
		await runTool('cancel_all_orders', { market_slug: MARKET_SLUG }, context);
		expect(fake.requests.at(-1)?.body).toEqual({ slugs: [MARKET_SLUG] });
	});
});

describe('the largest order', () => {
	test('an order at the cap goes; an order over it is refused and never sent', async () => {
		const { context, fake } = await setUp();
		await runTool('place_order', { ...order, quantity: 100, price: '0.5' }, context); // 50.00: at the cap
		const error = await failure(runTool('place_order', { ...order, quantity: 100, price: '0.51' }, context));
		expect(error.errorClass).toBe('denied');
		expect(error.message).toContain('over the largest order of 50 USD');
		expect(error.details).toMatchObject({ estimatedNotionalUsd: '51', capUsd: '50' });
		expect(fake.requests.filter((r) => r.path === '/v1/orders').length).toBe(1);
	});

	test('the setting changes the cap, and a bad setting is a clear error', async () => {
		const small = await setUp({ env: { POLYMARKET_US_MAX_ORDER_USD: '2' } });
		expect((await failure(runTool('place_order', order, small.context))).errorClass).toBe('denied');
		small.fake.stop();
		const bad = await setUp({ env: { POLYMARKET_US_MAX_ORDER_USD: 'lots' } });
		const error = await failure(runTool('place_order', order, bad.context));
		expect(error.errorClass).toBe('invalid');
		expect(error.message).toContain('largest order setting');
	});

	test('a MARKET buy uses the best ask; with no best bid or offer it is refused', async () => {
		const { context, fake } = await setUp({ fake: { bestAsk: '0.60' } });
		const placed = await runTool('place_order', { ...order, type: 'MARKET', price: undefined, quantity: 50 }, context);
		expect(placed.estimatedNotionalUsd).toBe('30');
		expect(await failure(runTool('place_order', { ...order, type: 'MARKET', price: undefined, quantity: 100 }, context))).toMatchObject({ errorClass: 'denied' });
		fake.failNext(404, 'no market data');
		const unknown = await failure(runTool('place_order', { ...order, type: 'MARKET', price: undefined, quantity: 1 }, context));
		expect(unknown.errorClass).toBe('denied');
		expect(unknown.message).toContain('cannot estimate');
		expect(fake.requests.filter((r) => r.path === '/v1/orders').length).toBe(1);
	});

	test('modify_order with price and quantity checks the cap', async () => {
		const { context, fake } = await setUp();
		await runTool('place_order', order, context);
		const error = await failure(
			runTool('modify_order', { order_id: 'ord-1', market_slug: MARKET_SLUG, price: '0.9', quantity: 100 }, context),
		);
		expect(error.errorClass).toBe('denied');
		const changed = await runTool('modify_order', { order_id: 'ord-1', market_slug: MARKET_SLUG, price: '0.5' }, context);
		expect(changed.modified).toBe(true);
		expect(fake.openOrders.get('ord-1')?.price).toEqual({ value: '0.5', currency: 'USD' });
	});

	test('close_position estimates |net| × best bid for a long, and refuses over the cap', async () => {
		const big = await setUp({ fake: { netPosition: '200', bestBid: '0.40' } });
		const error = await failure(runTool('close_position', { market_slug: MARKET_SLUG }, big.context));
		expect(error.details).toMatchObject({ estimatedNotionalUsd: '80' });
		expect(big.fake.requests.some((r) => r.path === '/v1/order/close-position')).toBe(false);
		big.fake.stop();
		const small = await setUp({ fake: { netPosition: '-20', bestAsk: '0.45' } });
		const closed = await runTool('close_position', { market_slug: MARKET_SLUG }, small.context);
		expect(closed.estimatedNotionalUsd).toBe('9');
		expect(small.fake.requests.at(-1)?.body).toEqual({
			marketSlug: MARKET_SLUG,
			manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
		});
	});

	test('more than the orders a minute is refused; a cancel is never limited', async () => {
		const { context } = await setUp({ env: { POLYMARKET_US_MAX_ORDERS_PER_MINUTE: '2' } });
		await runTool('place_order', order, context);
		await runTool('place_order', order, context);
		expect((await failure(runTool('place_order', order, context))).errorClass).toBe('limit');
		await runTool('cancel_all_orders', {}, context);
	});
});

describe('errors from the vendor', () => {
	test('a refused order carries the vendor message as invalid', async () => {
		const { context, fake } = await setUp();
		fake.failNext(400, 'insufficient buying power');
		const error = await failure(runTool('place_order', order, context));
		expect(error.errorClass).toBe('invalid');
		expect(error.message).toContain('insufficient buying power');
	});

	test('the latency stopgap is transient, not a rate limit', async () => {
		const { context, fake } = await setUp();
		fake.failNext(400, 'Order Processing Max Delay Exceeded');
		expect((await failure(runTool('place_order', order, context))).errorClass).toBe('transient');
	});

	test('a 429 on a read waits 1 s and 2 s and tries again; a 429 on an order does not', async () => {
		const { context, fake, slept } = await setUp();
		fake.limitNext(2);
		await runTool('get_balances', {}, context);
		expect(slept.filter((ms) => ms >= 1000)).toEqual([1000, 2000]);
		fake.limitNext(1);
		const error = await failure(runTool('place_order', order, context));
		expect(error.errorClass).toBe('limit');
		expect(fake.openOrders.size).toBe(0);
	});

	test('a 429 three times on a read is a limit error', async () => {
		const { context, fake } = await setUp();
		fake.limitNext(3);
		expect((await failure(runTool('get_balances', {}, context))).errorClass).toBe('limit');
	});

	test('a wrong key is an auth error that says to replace it', async () => {
		const { context } = await setUp();
		const other = await makeTestKey('pmus-test-key-0001');
		const wrong = await contextFromEnv({
			POLYMARKET_US_API_URL: fake?.apiUrl,
			POLYMARKET_US_GATEWAY_URL: fake?.gatewayUrl,
			POLYMARKET_KEY_ID: 'pmus-test-key-0001',
			POLYMARKET_SECRET_KEY: other.secretKey,
		});
		const error = await failure(runTool('get_balances', {}, wrong.context));
		expect(error.errorClass).toBe('auth');
		expect(error.message).toContain('did not accept the key');
		await runTool('get_balances', {}, context);
	});

	test('a clock 40 seconds off says to check the clock of the hub', async () => {
		const { context } = await setUp({ clockOffsetMs: 40_000 });
		const error = await failure(runTool('get_balances', {}, context));
		expect(error.errorClass).toBe('auth');
		expect(error.message).toContain('Check the clock of the hub.');
		expect(error.message).toMatch(/4[01] seconds ahead/); // the Date header has whole seconds
	});

	test('a secret key in the wrong form is an auth error at the first call', async () => {
		const { context } = await setUp({ env: { POLYMARKET_SECRET_KEY: 'bm90IGEga2V5' } });
		const error = await failure(runTool('get_balances', {}, context));
		expect(error.errorClass).toBe('auth');
		expect(error.message).toContain('Copy the secret key again');
	});

	test('bad input is invalid and sends nothing', async () => {
		const { context, fake } = await setUp();
		expect((await failure(runTool('place_order', { ...order, price: undefined }, context))).message).toContain('price is required');
		expect((await failure(runTool('place_order', { ...order, intent: 'HOLD' }, context))).errorClass).toBe('invalid');
		expect((await failure(runTool('place_order', { ...order, tif: 'DAY' }, context))).errorClass).toBe('invalid');
		expect((await failure(runTool('place_order', { ...order, extra: 1 }, context))).message).toContain('Unknown input');
		expect(fake.requests.length).toBe(0);
	});
});

describe('the secret key', () => {
	test('is in no tool result and no error message', async () => {
		const { context, key, fake, secrets } = await setUp();
		const seen: string[] = [];
		const call = async (name: string, args: Record<string, unknown>) => {
			const reply = await handleMessage(
				{ jsonrpc: '2.0', id: seen.length + 1, method: 'tools/call', params: { name, arguments: args } },
				context,
				secrets,
			);
			seen.push(JSON.stringify(reply));
		};
		await call('get_balances', {});
		await call('place_order', order);
		await call('place_order', { ...order, quantity: 1000 });
		fake.failNext(400, `echo ${key.secretKey}`);
		await call('get_positions', {});
		fake.failNext(401, `bad ${key.secretKey}`);
		await call('get_balances', {});
		const all = seen.join('\n');
		expect(all).toContain('[secret]');
		expect(all).not.toContain(key.secretKey);
	});
});
