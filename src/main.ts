/**
 * The entry point: read the settings from the environment, then serve MCP on stdio. Roost starts
 * this file with its own Bun and fills the environment from its vault at start.
 *
 * - POLYMARKET_KEY_ID, POLYMARKET_SECRET_KEY: the key from polymarket.us/developer. Both, or
 *   neither (then only the public tools work).
 * - POLYMARKET_US_MAX_ORDER_USD: the largest order in USD. Default 50.
 * - POLYMARKET_US_MAX_ORDERS_PER_MINUTE: orders (place, modify, close) in one minute. Default 10.
 * - POLYMARKET_US_API_URL, POLYMARKET_US_GATEWAY_URL: other hosts, for tests only.
 *
 * Nothing here writes a key to stdout, stderr, or a file.
 */
import { API_URL, GATEWAY_URL, PolymarketUsClient } from './client.ts';
import { serveStdio } from './mcp.ts';
import { capUnits } from './notional.ts';
import { createSigner, KeyFormatError, type Signer } from './sign.ts';
import { ToolError } from './errors.ts';
import type { ToolContext } from './tools.ts';

export async function contextFromEnv(
	env: Record<string, string | undefined>,
	options: {
		fetch?: (input: string, init: RequestInit) => Promise<Response>;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<{ context: ToolContext; secrets: string[] }> {
	const keyId = env.POLYMARKET_KEY_ID?.trim() ?? '';
	const secretKey = env.POLYMARKET_SECRET_KEY?.trim() ?? '';
	const secrets = [secretKey].filter(Boolean);
	let signer: Signer | null = null;
	let keyProblem: string | null = null;
	if (keyId && secretKey) {
		try {
			signer = await createSigner(keyId, secretKey, options.now);
		} catch (error) {
			keyProblem =
				error instanceof KeyFormatError
					? `${error.message} Copy the secret key again from polymarket.us/developer, then replace it on the app page.`
					: 'The secret key does not work. Make a new key at polymarket.us/developer, then replace it on the app page.';
		}
	}
	const client = new PolymarketUsClient({
		apiUrl: env.POLYMARKET_US_API_URL?.trim() || API_URL,
		gatewayUrl: env.POLYMARKET_US_GATEWAY_URL?.trim() || GATEWAY_URL,
		signer: keyProblem
			? {
					sign: () => {
						throw new ToolError('auth', keyProblem ?? '');
					},
				}
			: signer,
		fetch: options.fetch,
		now: options.now,
		sleep: options.sleep,
		secrets,
	});
	const perMinute = Number(env.POLYMARKET_US_MAX_ORDERS_PER_MINUTE?.trim() || '10');
	const sent: number[] = [];
	const now = options.now ?? Date.now;
	const context: ToolContext = {
		client,
		cap: () => capUnits(env.POLYMARKET_US_MAX_ORDER_USD),
		takeOrderSlot() {
			const at = now();
			while (sent.length > 0 && (sent[0] ?? 0) <= at - 60_000) sent.shift();
			const limit = Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 10;
			if (sent.length >= limit) {
				throw new ToolError(
					'limit',
					`This account sent ${limit} orders in the last minute, the most that the Polymarket US app allows. Wait a minute, then try again.`,
				);
			}
			sent.push(at);
		},
	};
	return { context, secrets };
}

if (import.meta.main) {
	const { context, secrets } = await contextFromEnv(process.env);
	await serveStdio(context, secrets);
}
