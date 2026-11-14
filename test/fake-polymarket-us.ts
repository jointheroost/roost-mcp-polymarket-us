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

const market = {
	market: {
		id: 'mkt-1',
		slug: MARKET_SLUG,
		question: 'Will the Fed cut rates in December?',
		active: true,
		closed: false,
	},
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
				return json(200, { events: [{ slug: 'fed-december', title: 'Fed in December', markets: [market.market] }] });
			}
			if (path === `/v1/market/slug/${MARKET_SLUG}`) return json(200, market);
			if (path === `/v1/markets/${MARKET_SLUG}/book`) {
				return json(200, { marketData: { ...bbo().marketData, bids: [{ px: { value: '0.40' }, qty: '100' }], offers: [{ px: { value: '0.45' }, qty: '80' }] } });
			}
			if (path === `/v1/markets/${MARKET_SLUG}/bbo`) return json(200, bbo());
			if (path === '/v1/price-history') {
				return json(200, { history: [{ t: 1731542400, yes: '0.41', no: '0.59' }] });
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
						[MARKET_SLUG]: { netPositionDecimal: options.netPosition ?? '20', cost: { value: '8.00', currency: 'USD' } },
					},
					eof: true,
				});
			}
			if (method === 'GET' && path === '/v1/portfolio/activities') return json(200, { activities: [], eof: true });
			if (method === 'GET' && path === '/v1/orders/open') return json(200, { orders: [...openOrders.values()] });
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
