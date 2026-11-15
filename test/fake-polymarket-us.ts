/**
 * A fake Polymarket US for tests: an API host that checks the three signed headers (the key ID,
 * a timestamp within 30 seconds, and the Ed25519 signature over timestamp + method + path) and a
 * public gateway host. Answers follow the shapes of the OpenAPI copies in `openapi/`.
 */

export interface TestKey {
	keyId: string;
	/** base64 of seed (32 bytes) + public key (32 bytes), as the developer page gives it. */
	secretKey: string;
	publicKey: CryptoKey;
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** A new Ed25519 key in the vendor's form. */
export async function makeTestKey(keyId = 'pmus-test-key-0001'): Promise<TestKey> {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as unknown as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const both = new Uint8Array(64);
	both.set(pkcs8.slice(-32), 0);
	both.set(raw, 32);
	return { keyId, secretKey: toBase64(both), publicKey: pair.publicKey };
}

export interface RecordedRequest {
	host: 'api' | 'gateway';
	method: string;
	path: string;
	query: Record<string, string[]>;
	body: Record<string, unknown> | null;
	headers: Record<string, string>;
}

export interface FakeOptions {
	key: TestKey;
	/** The vendor's clock in milliseconds. */
	clock?: () => number;
	bestBid?: string;
	bestAsk?: string;
	/** Net position of the market "fed-cut-december" (a decimal string; negative for short). */
	netPosition?: string;
}

export interface FakePolymarketUs {
	apiUrl: string;
	gatewayUrl: string;
	requests: RecordedRequest[];
	/** Answer the next `count` requests with 429. */
	limitNext(count: number): void;
	/** Answer the next request with this status and message. */
	failNext(status: number, message: string): void;
	openOrders: Map<string, Record<string, unknown>>;
	stop(): void;
}

const json = (status: number, value: unknown) =>
	new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export const MARKET_SLUG = 'fed-cut-december';

const RULES =
	'This market resolves to Yes if the stated condition is met by the end date, as reported by the named source. Otherwise it resolves to No. The exchange may use its own sources to settle a dispute, and its decision is final. See the rulebook for details.';

/** A market with the fields and the size of a real gateway answer (41 keys, about 2 KB). */
export function realMarket(slug: string, title: string, question: string, yes = '0.4200', no = '0.5800') {
	return {
		id: String(Math.abs([...slug].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7)) % 10_000_000),
		question,
		slug,
		endDate: '2026-12-31T04:59:00Z',
		category: 'macro',
		startDate: '2026-01-02T15:00:00Z',
		image: `https://polymarket-upload.s3.us-east-2.amazonaws.com/markets/${slug}/image-large-resolution.png`,
		imageDisplayType: 'IMAGE_DISPLAY_TYPE_ICON',
		description: RULES,
		active: true,
		marketType: 'binary',
		closed: false,
		createdAt: '2026-01-02T15:00:00.123456Z',
		updatedAt: '2026-11-13T21:44:12.654321Z',
		archived: false,
		orderPriceMinTickSize: 0.01,
		gameStartTime: '2026-12-31T04:59:00Z',
		manualActivation: false,
		sportsMarketType: 'futures',
		marketSides: [
			{
				id: '9000001',
				marketSideType: 'MARKET_SIDE_TYPE_YES',
				identifier: slug,
				createdAt: '2026-01-02T15:00:00.123456Z',
				updatedAt: '2026-11-13T21:44:12.654321Z',
				description: 'Yes',
				price: yes,
				marketId: 1234567,
				long: true,
				tradable: true,
				quote: { value: yes, currency: 'USD' },
			},
			{
				id: '9000002',
				marketSideType: 'MARKET_SIDE_TYPE_NO',
				identifier: slug,
				createdAt: '2026-01-02T15:00:00.123456Z',
				updatedAt: '2026-11-13T21:44:12.654321Z',
				description: 'No',
				price: no,
				marketId: 1234567,
				long: false,
				tradable: true,
				quote: { value: no, currency: 'USD' },
			},
		],
		outcomes: '["Yes","No"]',
		outcomePrices: `["${yes}","${no}"]`,
		ep3Status: 'EP3_STATUS_OPEN',
		status: 'MARKET_STATUS_OPEN',
		assetPriceTerms: {},
		sportsMarketTypeV2: 'SPORTS_MARKET_TYPE_V2_FUTURES',
		hidden: false,
		tags: [{ id: '1', label: 'Macro', slug: 'macro' }],
		title,
		subtitle: 'Resolves at the end of the year',
		color: '#1D4ED8',
		darkColor: '#93C5FD',
		feeCoefficient: 0.05,
		sortOrder: 3,
		bestBidQuote: { value: '0.4000', currency: 'USD' },
		bestAskQuote: { value: '0.4500', currency: 'USD' },
		metadata: { source: 'sample', note: 'x'.repeat(120) },
		titleShort: title.slice(0, 16),
		ep3SyncedAt: '2026-11-13T21:44:12.654321Z',
		minimumTradeQty: 0.01,
		volume: 1_234_567.5,
		volume24hr: 12_345.25,
		volume1wk: 98_765.5,
		volume1mo: 345_678.5,
		volume1yr: 1_234_567.5,
		rulesDisclaimer: RULES,
		rulesDisclaimerPopup: RULES,
		comboEnabled: false,
		singlesRfqConfig: {
			enabled: true,
			midpointDeviation: 0.05,
			minOrderValueUsd: 5,
			maxQuoteAgeSeconds: 30,
			quoteWindows: [{ start: '00:00', end: '23:59' }],
			ruleName: 'default',
			version: '1',
		},
	};
}

const market = { market: realMarket(MARKET_SLUG, 'December cut', 'Will the Fed cut rates in December?') };

/** An event with `count` markets, like a real search answer. */
function realEvent(index: number, count: number) {
	const slug = `fed-event-${index}`;
	return {
		id: String(124_000 + index),
		chatChannel: { id: `chat-${index}`, type: 'CHAT_CHANNEL_TYPE_EVENT', chatMemberCount: 42 },
		ticker: slug.toUpperCase(),
		slug,
		title: `Fed Funds Rate, round ${index}?`,
		description: RULES,
		startDate: '2026-01-02T15:00:00Z',
		endDate: '2026-12-31T04:59:00Z',
		image: `https://polymarket-upload.s3.us-east-2.amazonaws.com/events/${slug}.png`,
		active: true,
		closed: false,
		archived: false,
		category: 'macro',
		createdAt: '2026-01-02T15:00:00.123456Z',
		updatedAt: '2026-11-13T21:44:12.654321Z',
		startTime: '2026-01-02T15:00:00Z',
		volume: 5_000_000 + index,
		volume24hr: 50_000,
		markets: Array.from({ length: count }, (_, at) =>
			realMarket(`${slug}-m${at}`, `Option ${at}`, `Fed Funds Rate, round ${index}?`, '0.3000', '0.7000'),
		),
		participants: [],
		hidden: false,
		tags: [
			{ id: '1', label: 'Macro', slug: 'macro', image: 'https://example.test/tag-1.png' },
			{ id: '2', label: 'Fed', slug: 'fed', image: 'https://example.test/tag-2.png' },
		],
		teams: [],
		sortType: 'EVENT_SORT_TYPE_VOLUME',
		marketGroups: [],
		combos: { enabled: false },
		insiderTradingRules: {},
	};
}

/** The real gateway answers 400 with this body when the request is wrong. */
const BAD_REQUEST = { code: 3, message: 'The server was unable to process your request.', details: [] };

/** The documented fixed profiles of /v1/price-history: how many minutes between two points. */
const HISTORY_FIDELITY: Record<string, number> = {
	INTERVAL_1H: 1,
	INTERVAL_6H: 1,
	INTERVAL_1D: 5,
	INTERVAL_1W: 180,
	INTERVAL_1M: 180,
	INTERVAL_ALL: 180,
	INTERVAL_LIVE: 1,
};
const HISTORY_SPAN_MINUTES: Record<string, number> = {
	INTERVAL_1H: 60,
	INTERVAL_6H: 360,
	INTERVAL_1D: 1440,
	INTERVAL_1W: 10_080,
	INTERVAL_1M: 43_200,
	INTERVAL_ALL: 129_600,
	INTERVAL_LIVE: 60,
};

export function startFakePolymarketUs(options: FakeOptions): FakePolymarketUs {
	const clock = options.clock ?? Date.now;
	const requests: RecordedRequest[] = [];
	const openOrders = new Map<string, Record<string, unknown>>();
	let limited = 0;
	let failure: { status: number; message: string } | null = null;
	let nextId = 1;
	const bbo = () => ({
		marketData: {
			marketSlug: MARKET_SLUG,
			bestBid: { value: options.bestBid ?? '0.40', currency: 'USD' },
			bestAsk: { value: options.bestAsk ?? '0.45', currency: 'USD' },
			lastTradePx: { value: '0.42', currency: 'USD' },
		},
	});

	async function record(host: 'api' | 'gateway', request: Request): Promise<RecordedRequest> {
		const url = new URL(request.url);
		const query: Record<string, string[]> = {};
		for (const [key, value] of url.searchParams) (query[key] ??= []).push(value);
		const text = await request.text();
		const entry: RecordedRequest = {
			host,
			method: request.method,
			path: url.pathname,
			query,
			body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
			headers: Object.fromEntries(request.headers.entries()),
		};
		requests.push(entry);
		return entry;
	}

	function early(): Response | null {
		if (limited > 0) {
			limited--;
			return json(429, { status: 429, message: 'Too Many Requests' });
		}
		if (failure) {
			const { status, message } = failure;
			failure = null;
			return json(status, { message });
		}
		return null;
	}

	async function verify(entry: RecordedRequest): Promise<Response | null> {
		const keyId = entry.headers['x-pm-access-key'];
		const timestamp = entry.headers['x-pm-timestamp'];
		const signature = entry.headers['x-pm-signature'];
		if (!keyId || !timestamp || !signature) return json(401, { message: 'missing auth headers' });
		if (keyId !== options.key.keyId) return json(401, { message: 'unknown key' });
		if (Math.abs(clock() - Number(timestamp)) > 30_000) {
			return json(401, { message: 'timestamp outside the allowed window' });
		}
		const message = new TextEncoder().encode(`${timestamp}${entry.method}${entry.path}`);
		const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
		const ok = await crypto.subtle.verify('Ed25519', options.key.publicKey, bytes, message);
		return ok ? null : json(401, { message: 'invalid signature' });
	}

	const gateway = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const entry = await record('gateway', request);
			const stop = early();
			if (stop) return stop;
			const path = entry.path;
			if (path === '/v1/search') {
				const limit = Number(entry.query.limit?.[0] ?? 10);
				return json(200, {
					events: Array.from({ length: Math.min(limit, 8) }, (_, at) => realEvent(at + 1, 12)),
				});
			}
			if (path === `/v1/market/slug/${MARKET_SLUG}`) return json(200, market);
			if (path === `/v1/markets/${MARKET_SLUG}/book`) {
				return json(200, { marketData: { ...bbo().marketData, bids: [{ px: { value: '0.40' }, qty: '100' }], offers: [{ px: { value: '0.45' }, qty: '80' }] } });
			}
			if (path === `/v1/markets/${MARKET_SLUG}/bbo`) return json(200, bbo());
			if (path === '/v1/price-history') {
				const symbol = entry.query.symbol?.[0];
				const interval = entry.query.fixedInterval?.[0];
				const start = entry.query['timestamp.startTimestamp']?.[0];
				const end = entry.query['timestamp.endTimestamp']?.[0];
				const fidelity = Number(entry.query.fidelity?.[0]);
				// What the real gateway refused on 2026-11-14: a missing symbol or fidelity, a fixed
				// interval together with a range, and half a range.
				if (!symbol || !Number.isFinite(fidelity)) return json(400, BAD_REQUEST);
				if (interval && (start || end)) return json(400, BAD_REQUEST);
				if (Boolean(start) !== Boolean(end)) return json(400, BAD_REQUEST);
				if (interval && !(interval in HISTORY_FIDELITY)) return json(400, BAD_REQUEST);
				if (!interval && !start) return json(400, BAD_REQUEST);
				if (symbol !== MARKET_SLUG) return json(200, {});
				const minutes = interval ? (HISTORY_SPAN_MINUTES[interval] ?? 60) : (Number(end) - Number(start)) / 60;
				const step = interval ? (HISTORY_FIDELITY[interval] ?? 1) : 1;
				const count = Math.max(1, Math.floor(minutes / step));
				const from = interval ? 1_794_700_000 - minutes * 60 : Number(start);
				return json(200, {
					history: Array.from({ length: count }, (_, at) => ({
						timestamp: from + at * step * 60,
						longPrice: 0.4 + (at % 10) / 100,
						shortPrice: 0.6 - (at % 10) / 100,
					})),
				});
			}
			return json(404, { message: `no route ${path}` });
		},
	});

	const api = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const entry = await record('api', request);
			const stop = early();
			if (stop) return stop;
			const refused = await verify(entry);
			if (refused) return refused;
			const { path, method, body } = entry;
			if (method === 'GET' && path === '/v1/account/balances') {
				return json(200, { balances: [{ currentBalance: 125.5, currency: 'USD', buyingPower: 100.25 }] });
			}
			if (method === 'GET' && path === '/v1/portfolio/positions') {
				return json(200, {
					positions: {
						[MARKET_SLUG]: {
							netPosition: '20',
							qtyBought: '20',
							qtySold: '0',
							cost: { value: '8.00', currency: 'USD' },
							realized: { value: '0', currency: 'USD' },
							bodPosition: '20',
							expired: false,
							updateTime: '2026-11-13T21:44:12.654321Z',
							marketMetadata: {
								slug: MARKET_SLUG,
								icon: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/markets/fed-cut-december/icon.png',
								title: 'December cut',
								outcome: 'Yes',
								eventSlug: 'fed-december',
							},
							cashValue: { value: '0.40', currency: 'USD' },
							qtyAvailable: '20',
							netPositionDecimal: options.netPosition ?? '20',
							qtyBoughtDecimal: '20',
							qtySoldDecimal: '0',
							bodPositionDecimal: '20',
							qtyAvailableDecimal: '20',
						},
					},
					nextCursor: '',
					eof: true,
				});
			}
			if (method === 'GET' && path === '/v1/portfolio/activities') {
				const limit = Number(entry.query.limit?.[0] ?? 10);
				return json(200, {
					activities: Array.from({ length: Math.min(limit, 20) }, (_, at) => ({
						type: 'ACTIVITY_TYPE_TRADE',
						trade: {
							id: `trade-${at + 1}`,
							marketSlug: MARKET_SLUG,
							state: 'TRADE_STATE_CLEARED',
							createTime: '2026-11-13T21:44:12.654321Z',
							updateTime: '2026-11-13T21:44:13.654321Z',
							price: { value: '0.4000', currency: 'USD' },
							qty: '5',
							isAggressor: true,
							costBasis: { value: '2.05', currency: 'USD' },
							realizedPnl: { value: '0', currency: 'USD' },
							qtyDecimal: '5',
							// Mochi saw the whole market repeated in each trade.
							marketMetadata: { slug: MARKET_SLUG, icon: 'https://example.test/icon.png', title: 'December cut', outcome: 'Yes', eventSlug: 'fed-december' },
							market: realMarket(MARKET_SLUG, 'December cut', 'Will the Fed cut rates in December?'),
						},
					})),
					nextCursor: 'next-page',
					eof: false,
				});
			}
			if (method === 'GET' && path === '/v1/orders/open') {
				const orders = [...openOrders.values()].map((order) => ({
					...order,
					marketMetadata: { slug: MARKET_SLUG, icon: 'https://example.test/icon.png', title: 'December cut', outcome: 'Yes', eventSlug: 'fed-december' },
					cumQuantity: 0,
					leavesQuantity: order.quantity,
					commissionsBasisPoints: '50',
					makerCommissionsBasisPoints: '0',
					createTime: '2026-11-13T21:44:12.654321Z',
				}));
				return json(200, { orders });
			}
			const orderMatch = /^\/v1\/order\/([^/]+)(?:\/(cancel|modify))?$/.exec(path);
			if (method === 'POST' && path === '/v1/order/preview') {
				return json(200, { order: { ...(body?.request as object), state: 'ORDER_STATE_PREVIEW' } });
			}
			if (method === 'POST' && path === '/v1/order/close-position') return json(200, { id: `close-${nextId++}` });
			if (method === 'POST' && path === '/v1/orders') {
				const id = `ord-${nextId++}`;
				openOrders.set(id, { id, ...body, state: 'ORDER_STATE_NEW' });
				return json(200, { id });
			}
			if (method === 'POST' && path === '/v1/orders/open/cancel') {
				const ids = [...openOrders.keys()];
				openOrders.clear();
				return json(200, { canceledOrderIds: ids });
			}
			if (orderMatch) {
				const [, id = '', action] = orderMatch;
				const order = openOrders.get(id);
				if (!order) return json(404, { message: `order ${id} not found` });
				if (method === 'GET' && !action) return json(200, { order });
				if (method === 'POST' && action === 'cancel') {
					openOrders.delete(id);
					return json(200, {});
				}
				if (method === 'POST' && action === 'modify') {
					openOrders.set(id, { ...order, ...body });
					return json(200, {});
				}
			}
			return json(404, { message: `no route ${method} ${path}` });
		},
	});

	return {
		apiUrl: `http://127.0.0.1:${api.port}`,
		gatewayUrl: `http://127.0.0.1:${gateway.port}`,
		requests,
		openOrders,
		limitNext(count) {
			limited = count;
		},
		failNext(status, message) {
			failure = { status, message };
		},
		stop() {
			api.stop(true);
			gateway.stop(true);
		},
	};
}
