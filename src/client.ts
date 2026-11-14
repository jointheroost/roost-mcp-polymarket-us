/**
 * The HTTP client of the Polymarket US API. Two hosts (docs.polymarket.us/api-reference/introduction,
 * read 2026-11-14): `api.polymarket.us` (orders, portfolio, account; each request signed) and
 * `gateway.polymarket.us` (public market data; no key). Limits
 * (docs.polymarket.us/api-reference/rate-limits): 25 requests a second for each source IP; a 429
 * means "wait at least 1 second, then retry with exponential backoff".
 */
import { MISSING_KEY_MESSAGE, redact, ToolError } from './errors.ts';
import type { Signer } from './sign.ts';

export const API_URL = 'https://api.polymarket.us';
export const GATEWAY_URL = 'https://gateway.polymarket.us';
/** The vendor refuses a timestamp more than 30 seconds from its own clock. */
export const CLOCK_WINDOW_MS = 30_000;
/** At most 25 requests a second: keep 40 ms between two requests of this process. */
const MIN_GAP_MS = 40;
/** A read that got a 429 tries this many times in all (1 s, then 2 s between). */
const READ_ATTEMPTS = 3;
const MAX_MESSAGE = 500;

export type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface RequestSpec {
	/** `private`: api.polymarket.us, signed. `public`: gateway.polymarket.us, no key. */
	host: 'private' | 'public';
	method: 'GET' | 'POST';
	path: string;
	query?: Query;
	body?: Record<string, unknown>;
}

export interface ClientOptions {
	apiUrl?: string;
	gatewayUrl?: string;
	/** Null: no key. Signed requests then fail with `auth`. */
	signer: Signer | null;
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	timeoutMs?: number;
	/** Values that never leave this process in a message. */
	secrets?: readonly string[];
}

/** The text of a vendor error body: its `message`, else `error`, else the text. Pure. */
function vendorMessage(text: string): string {
	try {
		const data = JSON.parse(text) as { message?: unknown; error?: unknown };
		const message = typeof data.message === 'string' ? data.message : data.error;
		if (typeof message === 'string' && message.trim()) return message.trim();
	} catch {
		// Not JSON: the text is the message.
	}
	return text.trim();
}

/** The latency stopgap of the vendor: not a rate limit, the order may be sent again. */
const STOPGAP = /Order Processing Max Delay Exceeded|Global Rate Limit Exceeded/i;

export class PolymarketUsClient {
	private readonly apiUrl: string;
	private readonly gatewayUrl: string;
	private readonly fetchFn: NonNullable<ClientOptions['fetch']>;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly timeoutMs: number;
	private readonly secrets: readonly string[];
	private lastAt = 0;

	constructor(private readonly options: ClientOptions) {
		this.apiUrl = options.apiUrl ?? API_URL;
		this.gatewayUrl = options.gatewayUrl ?? GATEWAY_URL;
		this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.secrets = options.secrets ?? [];
	}

	get hasKey(): boolean {
		return this.options.signer !== null;
	}

	/** One request. A read (GET) that gets a 429 waits and tries again; a POST never does. */
	async request(spec: RequestSpec): Promise<unknown> {
		const attempts = spec.method === 'GET' ? READ_ATTEMPTS : 1;
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.once(spec);
			} catch (error) {
				const limited = error instanceof ToolError && error.errorClass === 'limit';
				if (!limited || attempt >= attempts) throw error;
				await this.sleep(1000 * 2 ** (attempt - 1));
			}
		}
	}

	private async once(spec: RequestSpec): Promise<unknown> {
		const base = spec.host === 'private' ? this.apiUrl : this.gatewayUrl;
		const url = new URL(spec.path, base);
		for (const [key, value] of Object.entries(spec.query ?? {})) {
			if (value === undefined) continue;
			if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
			else url.searchParams.set(key, String(value));
		}
		const headers: Record<string, string> = { accept: 'application/json' };
		if (spec.body) headers['content-type'] = 'application/json';
		if (spec.host === 'private') {
			const signer = this.options.signer;
			if (!signer) throw new ToolError('auth', MISSING_KEY_MESSAGE);
			Object.assign(headers, await signer.sign(spec.method, url.pathname));
		}
		const wait = this.lastAt + MIN_GAP_MS - this.now();
		if (wait > 0) await this.sleep(wait);
		this.lastAt = this.now();
		let response: Response;
		try {
			response = await this.fetchFn(url.toString(), {
				method: spec.method,
				headers,
				body: spec.body ? JSON.stringify(spec.body) : undefined,
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch {
			throw new ToolError('transient', 'Polymarket US did not answer. Try again in a minute.');
		}
		const text = await response.text();
		if (!response.ok) throw this.errorOf(response, text);
		if (!text.trim()) return {};
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new ToolError('failed', 'Polymarket US sent an answer that is not JSON.');
		}
	}

	private errorOf(response: Response, text: string): ToolError {
		const status = response.status;
		const said = redact(vendorMessage(text), this.secrets).slice(0, MAX_MESSAGE);
		const tail = said ? ` Polymarket US said: ${said}` : '';
		if (status === 401 || status === 403) {
			const serverTime = Date.parse(response.headers.get('date') ?? '');
			const off = Number.isNaN(serverTime) ? 0 : this.now() - serverTime;
			if (Math.abs(off) > CLOCK_WINDOW_MS) {
				const seconds = Math.round(Math.abs(off) / 1000);
				return new ToolError(
					'auth',
					`Polymarket US refused the request because the clock of the hub is ${seconds} seconds ${off > 0 ? 'ahead' : 'behind'}. Check the clock of the hub.`,
					{},
					status,
				);
			}
			return new ToolError(
				'auth',
				`Polymarket US did not accept the key. Make a new key at polymarket.us/developer, then replace it on the app page.${tail}`,
				{},
				status,
			);
		}
		if (status === 429) {
			return new ToolError(
				'limit',
				'Polymarket US says there were too many requests (25 a second for each address). Wait a second, then try again.',
				{},
				status,
			);
		}
		if (STOPGAP.test(said)) {
			return new ToolError(
				'transient',
				'Polymarket US was slow and rejected the order so that it would not fill at an old price. You may send it again.',
				{},
				status,
			);
		}
		if (status === 404) {
			return new ToolError('invalid', `Polymarket US found no such item.${tail}`, {}, status);
		}
		if (status >= 400 && status < 500) {
			return new ToolError('invalid', `Polymarket US refused the request.${tail}`, {}, status);
		}
		return new ToolError(
			'transient',
			`Polymarket US had a problem (HTTP ${status}). Try again in a minute.${tail}`,
			{},
			status,
		);
	}
}
