/**
 * The error of a tool call. `class` is what a caller acts on (the classes of Roost's app calls):
 * `auth` (a key is missing or refused), `invalid` (the input is wrong), `denied` (a check of this
 * server refused it, such as the largest order), `transient` (try again soon), `limit` (too many
 * requests), `failed` (anything else).
 */
export type ErrorClass = 'auth' | 'invalid' | 'denied' | 'transient' | 'limit' | 'failed';

export class ToolError extends Error {
	constructor(
		readonly errorClass: ErrorClass,
		message: string,
		/** Extra facts for the caller, such as the estimated notional. Never a secret. */
		readonly details: Record<string, unknown> = {},
		/** The HTTP status of the vendor, when the vendor answered. */
		readonly status: number | null = null,
	) {
		super(message);
	}
}

export const MISSING_KEY_MESSAGE =
	'Add your Polymarket US key on the app page. Public market tools work with no key.';

/** The text with each secret replaced. Values shorter than 8 characters are left. Pure. */
export function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret.length < 8) continue;
		out = out.split(secret).join('[secret]');
	}
	return out;
}
