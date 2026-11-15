/**
 * The tools. Read tools have `readOnlyHint`. Money tools (they place, change, or cancel orders)
 * are listed in `MONEY_TOOLS`; Roost's catalog entry lists the same names as `moneyTools`.
 *
 * Paths and bodies follow the dated OpenAPI copies in `openapi/` (read 2026-11-14) and the official
 * TypeScript SDK 0.1.1.
 */
import {
	compactActivities,
	compactHistory,
	compactMarketAnswer,
	compactOpenOrders,
	compactPositions,
	compactSearch,
} from './compact.ts';
import { checkInput, type ObjectSchema, type PropertySchema } from './check.ts';
import type { PolymarketUsClient } from './client.ts';
import { ToolError } from './errors.ts';
import { INTENTS, mapIntent, mapOrderType, mapTif, ORDER_TYPES, TIFS } from './mapping.ts';
import {
	amountUnits,
	bboPrices,
	checkCap,
	fromUnits,
	multiply,
	positionNet,
	toUnits,
} from './notional.ts';

export interface ToolContext {
	client: PolymarketUsClient;
	/** The largest order in units (from `POLYMARKET_US_MAX_ORDER_USD`). Throws for a bad setting. */
	cap(): bigint;
	/** Throws `limit` when this process sent too many orders in the last minute. */
	takeOrderSlot(): void;
}

export interface ToolDef {
	name: string;
	title: string;
	description: string;
	inputSchema: ObjectSchema;
	readOnly: boolean;
	/** Places, changes, or cancels an order. */
	money: boolean;
	run(input: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>;
}

/** The names of the money tools, for the catalog entry's `moneyTools`. */
export const MONEY_TOOLS = [
	'place_order',
	'modify_order',
	'cancel_order',
	'cancel_all_orders',
	'close_position',
] as const;

/** Orders that Roost sends are marked as sent by a program (orders-schema.json). */
const AUTOMATIC = 'MANUAL_ORDER_INDICATOR_AUTOMATIC';

const slug = (description: string): PropertySchema => ({
	type: 'string',
	description,
	maxLength: 300,
});
const MARKET_SLUG: PropertySchema = {
	...slug('The slug of the market (market_slug), from search_markets.'),
	hint: 'Get it from search_markets.',
};
const ORDER_ID: PropertySchema = {
	type: 'string',
	description: 'The order ID that Polymarket US gave the order.',
	maxLength: 200,
	hint: 'Get it from get_open_orders.',
};
const DETAIL: PropertySchema = {
	type: 'string',
	enum: ['compact', 'full'],
	description:
		'compact (the default) keeps the fields that you need to answer and to call the next tool. full gives the whole answer of Polymarket US, which can be very large.',
};
/** `detail: "full"` skips the compact shape. */
const isFull = (input: Record<string, unknown>) => input.detail === 'full';
const LIMIT: PropertySchema = {
	type: 'integer',
	description: 'How many items to return.',
	minimum: 1,
	maximum: 100,
};
const CURSOR: PropertySchema = {
	type: 'string',
	description: 'The nextCursor of the last answer, for the next page.',
	maxLength: 500,
};

const ORDER_FIELDS: Record<string, PropertySchema> = {
	market_slug: MARKET_SLUG,
	intent: {
		type: 'string',
		enum: INTENTS,
		description:
			'BUY_LONG buys YES, SELL_LONG sells YES, BUY_SHORT buys NO, SELL_SHORT sells NO. Prices are for the YES side.',
	},
	type: {
		type: 'string',
		enum: ORDER_TYPES,
		description: 'LIMIT needs a price. MARKET fills at the best price there is.',
	},
	quantity: {
		type: 'number',
		description: 'The number of contracts. Some markets take parts of a contract.',
		minimum: 0,
	},
	price: {
		type: 'string',
		description:
			'The price of one YES contract in USD as a decimal, for example "0.55". Needed for LIMIT. For MARKET, a reference price for the largest order check.',
		maxLength: 20,
	},
	tif: {
		type: 'string',
		enum: TIFS,
		description:
			'GTC (until filled or canceled, the default), GTD (until good_till_time), IOC, or FOK.',
	},
	good_till_time: {
		type: 'string',
		description: 'When a GTD order ends, as an ISO 8601 time.',
		maxLength: 40,
	},
};

const ORDER_SCHEMA: ObjectSchema = {
	type: 'object',
	properties: ORDER_FIELDS,
	required: ['market_slug', 'intent', 'type', 'quantity'],
	additionalProperties: false,
};

function object(
	properties: Record<string, PropertySchema>,
	required: readonly string[] = [],
): ObjectSchema {
	return { type: 'object', properties, required, additionalProperties: false };
}

/** Minutes between two points for each fixed interval (price-history-schema.json). */
const HISTORY_FIDELITY = { '1H': 1, '6H': 1, '1D': 5, '1W': 180, '1M': 180, ALL: 180, LIVE: 1 } as const;

const path = (template: string, value: unknown) =>
	template.replace('{}', encodeURIComponent(String(value)));

/** The structured value of a tool: the vendor's object, or `{ value }`. Pure. */
function asObject(data: unknown): Record<string, unknown> {
	return data && typeof data === 'object' && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: { value: data };
}

/** The order body of the vendor from the tool input. Throws `invalid`. */
function orderBody(input: Record<string, unknown>): Record<string, unknown> {
	const type = mapOrderType(String(input.type));
	const tif = mapTif(String(input.tif ?? 'GTC'));
	const quantity = input.quantity as number;
	if (toUnits(quantity) === null || quantity <= 0) {
		throw new ToolError('invalid', 'quantity must be a number above 0 with at most 9 decimals.');
	}
	const body: Record<string, unknown> = {
		marketSlug: input.market_slug,
		intent: mapIntent(String(input.intent)),
		type,
		quantity,
		tif,
	};
	const price = typeof input.price === 'string' ? input.price : '';
	if (price) {
		const units = toUnits(price);
		if (units === null || units <= 0n || units >= 10n ** 9n) {
			throw new ToolError('invalid', 'price must be a decimal above 0 and below 1, for example "0.55".');
		}
		body.price = { value: price, currency: 'USD' };
	} else if (type === 'ORDER_TYPE_LIMIT') {
		throw new ToolError('invalid', 'price is required for a LIMIT order, for example "0.55".');
	}
	if (input.good_till_time) body.goodTillTime = input.good_till_time;
	else if (tif === 'TIME_IN_FORCE_GOOD_TILL_DATE') {
		throw new ToolError('invalid', 'good_till_time is required when tif is GTD.');
	}
	return body;
}

/** The notional of a new order, or throws `denied` when it cannot be estimated (MARKET). */
async function orderNotional(
	body: Record<string, unknown>,
	context: ToolContext,
): Promise<{ notional: bigint; from: string }> {
	const quantity = toUnits(body.quantity) ?? 0n;
	const price = amountUnits(body.price);
	if (price !== null) return { notional: multiply(price, quantity), from: 'price × quantity' };
	let estimate: bigint | null = null;
	try {
		const bbo = await context.client.request({
			host: 'public',
			method: 'GET',
			path: path('/v1/markets/{}/bbo', body.marketSlug),
		});
		const { bid, ask, last } = bboPrices(bbo);
		const buying = body.intent === 'ORDER_INTENT_BUY_LONG' || body.intent === 'ORDER_INTENT_BUY_SHORT';
		estimate = buying ? (ask ?? last ?? bid) : (bid ?? last ?? ask);
	} catch {
		estimate = null;
	}
	if (estimate === null) {
		throw new ToolError(
			'denied',
			'Roost cannot estimate the cost of this MARKET order (no price and no best bid or offer). It was not sent. Use a LIMIT order with a price, or give a reference price.',
		);
	}
	return { notional: multiply(estimate, quantity), from: 'best bid or offer × quantity' };
}

export const TOOLS: readonly ToolDef[] = [
	// ------------------------------------------------------------ public, no key
	{
		name: 'search_markets',
		title: 'Search markets',
		description:
			'Search Polymarket US events and markets by words. Returns events, each with its first markets: slug, title, state, Yes and No prices, volume, end date. Use a market slug as market_slug in the other tools. Works with no key.',
		inputSchema: object(
			{
				query: { type: 'string', description: 'The words to search for.', maxLength: 200 },
				limit: { ...LIMIT, description: 'How many events to return.' },
				page: { type: 'integer', description: 'The page of events, from 1.', minimum: 1 },
				markets_per_event: {
					type: 'integer',
					description: 'How many markets to show for each event. Default 3. The event says its marketCount.',
					minimum: 1,
					maximum: 50,
				},
				detail: DETAIL,
			},
			['query'],
		),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const answer = asObject(
				await client.request({
					host: 'public',
					method: 'GET',
					path: '/v1/search',
					query: {
						query: input.query as string,
						limit: input.limit as number | undefined,
						page: input.page as number | undefined,
					},
				}),
			);
			return isFull(input) ? answer : compactSearch(answer, (input.markets_per_event as number | undefined) ?? 3);
		},
	},
	{
		name: 'get_market',
		title: 'Get a market',
		description:
			'One market by market_slug: question, state, Yes and No prices (USD for one contract, 0 to 1), volume, end date. detail "full" adds the rules text and the rest. Works with no key.',
		inputSchema: object({ market_slug: MARKET_SLUG, detail: DETAIL }, ['market_slug']),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const answer = asObject(
				await client.request({
					host: 'public',
					method: 'GET',
					path: path('/v1/market/slug/{}', input.market_slug),
				}),
			);
			return isFull(input) ? answer : compactMarketAnswer(answer);
		},
	},
	{
		name: 'get_order_book',
		title: 'Get the order book',
		description:
			'The order book of one market by market_slug: bids, offers, last price, and stats. Prices are for the YES side. Works with no key.',
		inputSchema: object({ market_slug: MARKET_SLUG }, ['market_slug']),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			return asObject(
				await client.request({
					host: 'public',
					method: 'GET',
					path: path('/v1/markets/{}/book', input.market_slug),
				}),
			);
		},
	},
	{
		name: 'get_price_history',
		title: 'Get price history',
		description:
			'Yes and No prices of one market over time, by market_slug. Give interval (default 1D), or start and end, not both. Returns up to 48 points as t (Unix seconds), yes, no. detail "full" gives every point. Works with no key.',
		inputSchema: object(
			{
				market_slug: MARKET_SLUG,
				interval: {
					type: 'string',
					enum: ['ALL', '1M', '1W', '1D', '6H', '1H', 'LIVE'],
					description: 'The time span. Default 1D. Do not use it with start and end.',
				},
				start: {
					type: 'integer',
					description: 'Start of a custom range in Unix seconds. Use it with end, up to 24 hours.',
					minimum: 0,
				},
				end: {
					type: 'integer',
					description: 'End of a custom range in Unix seconds. Use it with start.',
					minimum: 0,
				},
				detail: DETAIL,
			},
			['market_slug'],
		),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const start = input.start as number | undefined;
			const end = input.end as number | undefined;
			if (input.interval !== undefined && (start !== undefined || end !== undefined)) {
				throw new ToolError('invalid', 'Give interval, or start and end, not both.');
			}
			if ((start === undefined) !== (end === undefined)) {
				throw new ToolError('invalid', 'start and end go together. Give both, or neither.');
			}
			if (start !== undefined && end !== undefined && end <= start) {
				throw new ToolError('invalid', 'end must be after start.');
			}
			// The vendor takes a fixed interval with its own fidelity, or a range with fidelity 1, and
			// answers 400 for both together (OpenAPI price-history-schema.json, checked 2026-11-14).
			const interval = String(input.interval ?? '1D') as keyof typeof HISTORY_FIDELITY;
			const answer = asObject(
				await client.request({
					host: 'public',
					method: 'GET',
					path: '/v1/price-history',
					query:
						start !== undefined
							? {
									symbol: input.market_slug as string,
									fidelity: 1,
									'timestamp.startTimestamp': start,
									'timestamp.endTimestamp': end,
								}
							: {
									symbol: input.market_slug as string,
									fixedInterval: `INTERVAL_${interval}`,
									fidelity: HISTORY_FIDELITY[interval],
								},
				}),
			);
			if (isFull(input)) return answer;
			const compact = compactHistory(answer);
			return compact.points === 0
				? {
						...compact,
						note: 'Polymarket US has no price history for this market_slug. Check it with get_market.',
					}
				: compact;
		},
	},
	// ------------------------------------------------------------ read, with the key
	{
		name: 'get_balances',
		title: 'Get balances',
		description: 'The cash balance and buying power of the account, as Polymarket US gives them.',
		inputSchema: object({}),
		readOnly: true,
		money: false,
		async run(_input, { client }) {
			return asObject(await client.request({ host: 'private', method: 'GET', path: '/v1/account/balances' }));
		},
	},
	{
		name: 'get_positions',
		title: 'Get positions',
		description:
			'The positions of the account: market slug, side, quantity, costBasisUsd (total cost of the position as Polymarket US counts it, trading fees included, not the price of one fill), avgPrice (costBasisUsd / quantity), realizedPnlUsd, unrealizedPnlUsd. Give market_slug for one market.',
		inputSchema: object({ market_slug: MARKET_SLUG, limit: LIMIT, cursor: CURSOR, detail: DETAIL }),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const answer = asObject(
				await client.request({
					host: 'private',
					method: 'GET',
					path: '/v1/portfolio/positions',
					query: {
						market: input.market_slug as string | undefined,
						limit: input.limit as number | undefined,
						cursor: input.cursor as string | undefined,
					},
				}),
			);
			return isFull(input) ? answer : compactPositions(answer);
		},
	},
	{
		name: 'get_activities',
		title: 'Get activity',
		description:
			'Trades, resolutions, deposits, and withdrawals of the account, newest first. A trade has price (the fill price) and costBasisUsd (the cost of that trade, trading fee included), so costBasisUsd / quantity can differ from price. Give market_slug for one market.',
		inputSchema: object({ market_slug: MARKET_SLUG, limit: LIMIT, cursor: CURSOR, detail: DETAIL }),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const answer = asObject(
				await client.request({
					host: 'private',
					method: 'GET',
					path: '/v1/portfolio/activities',
					query: {
						marketSlug: input.market_slug as string | undefined,
						limit: input.limit as number | undefined,
						cursor: input.cursor as string | undefined,
					},
				}),
			);
			return isFull(input) ? answer : compactActivities(answer);
		},
	},
	{
		name: 'get_open_orders',
		title: 'Get open orders',
		description:
			'The open orders of the account: order ID, market slug, intent, price, quantity, filled and remaining. Give market_slug for one market.',
		inputSchema: object({ market_slug: MARKET_SLUG, detail: DETAIL }),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const answer = asObject(
				await client.request({
					host: 'private',
					method: 'GET',
					path: '/v1/orders/open',
					query: { slugs: input.market_slug ? [input.market_slug as string] : undefined },
				}),
			);
			return isFull(input) ? answer : compactOpenOrders(answer);
		},
	},
	{
		name: 'get_order',
		title: 'Get an order',
		description: 'One order of the account by order_id: its state, fills, and price.',
		inputSchema: object({ order_id: ORDER_ID }, ['order_id']),
		readOnly: true,
		money: false,
		async run(input, { client }) {
			return asObject(
				await client.request({ host: 'private', method: 'GET', path: path('/v1/order/{}', input.order_id) }),
			);
		},
	},
	{
		name: 'preview_order',
		title: 'Preview an order',
		description:
			'Check an order in market_slug and see its expected cost and fills, with no order sent and no money moved. Use it before place_order.',
		inputSchema: ORDER_SCHEMA,
		readOnly: true,
		money: false,
		async run(input, { client }) {
			const body = orderBody(input);
			return asObject(
				await client.request({
					host: 'private',
					method: 'POST',
					path: '/v1/order/preview',
					body: { request: body },
				}),
			);
		},
	},
	// ------------------------------------------------------------ money
	{
		name: 'place_order',
		title: 'Place an order',
		description:
			'Place a live order in market_slug with real money. An order over the largest order setting is refused and not sent. Use preview_order first.',
		inputSchema: ORDER_SCHEMA,
		readOnly: false,
		money: true,
		async run(input, context) {
			const body = orderBody(input);
			const cap = context.cap();
			const { notional, from } = await orderNotional(body, context);
			checkCap(notional, cap, from);
			context.takeOrderSlot();
			const data = asObject(
				await context.client.request({
					host: 'private',
					method: 'POST',
					path: '/v1/orders',
					body: { ...body, manualOrderIndicator: AUTOMATIC },
				}),
			);
			return {
				orderId: data.id ?? null,
				marketSlug: body.marketSlug,
				intent: body.intent,
				type: body.type,
				quantity: body.quantity,
				price: (body.price as { value: string } | undefined)?.value ?? null,
				estimatedNotionalUsd: fromUnits(notional),
				capUsd: fromUnits(cap),
				answer: data,
			};
		},
	},
	{
		name: 'modify_order',
		title: 'Change an order',
		description:
			'Change the price, quantity, or time in force of an open order (order_id, market_slug). With both a price and a quantity, the largest order check applies.',
		inputSchema: object(
			{
				order_id: ORDER_ID,
				market_slug: MARKET_SLUG,
				price: ORDER_FIELDS.price as PropertySchema,
				quantity: ORDER_FIELDS.quantity as PropertySchema,
				tif: ORDER_FIELDS.tif as PropertySchema,
				good_till_time: ORDER_FIELDS.good_till_time as PropertySchema,
			},
			['order_id', 'market_slug'],
		),
		readOnly: false,
		money: true,
		async run(input, context) {
			const body: Record<string, unknown> = { marketSlug: input.market_slug };
			const price = typeof input.price === 'string' ? input.price : '';
			if (price) {
				const units = toUnits(price);
				if (units === null || units <= 0n || units >= 10n ** 9n) {
					throw new ToolError('invalid', 'price must be a decimal above 0 and below 1, for example "0.55".');
				}
				body.price = { value: price, currency: 'USD' };
			}
			if (input.quantity !== undefined) {
				if (toUnits(input.quantity) === null || (input.quantity as number) <= 0) {
					throw new ToolError('invalid', 'quantity must be a number above 0 with at most 9 decimals.');
				}
				body.quantity = input.quantity;
			}
			if (input.tif) body.tif = mapTif(String(input.tif));
			if (input.good_till_time) body.goodTillTime = input.good_till_time;
			if (Object.keys(body).length === 1) {
				throw new ToolError('invalid', 'Give a new price, quantity, tif, or good_till_time.');
			}
			if (body.price && body.quantity !== undefined) {
				const notional = multiply(amountUnits(body.price) ?? 0n, toUnits(body.quantity) ?? 0n);
				checkCap(notional, context.cap(), 'price × quantity');
			}
			context.takeOrderSlot();
			const data = await context.client.request({
				host: 'private',
				method: 'POST',
				path: path('/v1/order/{}/modify', input.order_id),
				body,
			});
			return { modified: true, orderId: input.order_id, request: body, answer: asObject(data) };
		},
	},
	{
		name: 'cancel_order',
		title: 'Cancel an order',
		description: 'Cancel one open order by order_id and market_slug.',
		inputSchema: object({ order_id: ORDER_ID, market_slug: MARKET_SLUG }, ['order_id', 'market_slug']),
		readOnly: false,
		money: true,
		async run(input, { client }) {
			await client.request({
				host: 'private',
				method: 'POST',
				path: path('/v1/order/{}/cancel', input.order_id),
				body: { marketSlug: input.market_slug },
			});
			return { canceled: true, orderId: input.order_id, marketSlug: input.market_slug };
		},
	},
	{
		name: 'cancel_all_orders',
		title: 'Cancel all orders',
		description: 'Cancel every open order of the account, or every open order in market_slug.',
		inputSchema: object({ market_slug: MARKET_SLUG }),
		readOnly: false,
		money: true,
		async run(input, { client }) {
			return asObject(
				await client.request({
					host: 'private',
					method: 'POST',
					path: '/v1/orders/open/cancel',
					body: input.market_slug ? { slugs: [input.market_slug] } : {},
				}),
			);
		},
	},
	{
		name: 'close_position',
		title: 'Close a position',
		description:
			'Close the whole position in market_slug at the market price, with real money. Refused when the estimated value is over the largest order setting.',
		inputSchema: object({ market_slug: MARKET_SLUG }, ['market_slug']),
		readOnly: false,
		money: true,
		async run(input, context) {
			const { client } = context;
			const cap = context.cap();
			const market = input.market_slug as string;
			let estimate: bigint | null = null;
			try {
				const answer = asObject(
					await client.request({
						host: 'private',
						method: 'GET',
						path: '/v1/portfolio/positions',
						query: { market },
					}),
				);
				const map = answer.positions as Record<string, unknown> | undefined;
				const values = map && typeof map === 'object' ? Object.values(map) : [];
				const position = map?.[market] ?? (values.length === 1 ? values[0] : undefined);
				const net = positionNet(position);
				if (net === 0n) estimate = 0n;
				else if (net !== null) {
					const { bid, ask, last } = bboPrices(
						await client.request({ host: 'public', method: 'GET', path: path('/v1/markets/{}/bbo', market) }),
					);
					const price = net > 0n ? (bid ?? last ?? ask) : (ask ?? last ?? bid);
					if (price !== null) estimate = multiply(net > 0n ? net : -net, price);
				}
			} catch {
				estimate = null;
			}
			if (estimate !== null) checkCap(estimate, cap, '|net position| × best bid or offer');
			context.takeOrderSlot();
			const data = asObject(
				await client.request({
					host: 'private',
					method: 'POST',
					path: '/v1/order/close-position',
					body: { marketSlug: market, manualOrderIndicator: AUTOMATIC },
				}),
			);
			return {
				orderId: data.id ?? null,
				marketSlug: market,
				estimatedNotionalUsd: estimate === null ? null : fromUnits(estimate),
				capUsd: fromUnits(cap),
				answer: data,
			};
		},
	},
];

/** Run one tool: check the input, then call. Throws `ToolError`. */
export async function runTool(
	name: string,
	input: unknown,
	context: ToolContext,
): Promise<Record<string, unknown>> {
	const tool = TOOLS.find((item) => item.name === name);
	if (!tool) throw new ToolError('invalid', `There is no tool "${name}".`);
	return tool.run(checkInput(tool.inputSchema, input), context);
}
