/**
 * The largest order (the notional gate of the reference server in Chris's Grok bot): an order whose
 * estimated notional is over the cap is refused here and never sent. At the cap is allowed.
 *
 * - A LIMIT order (place, and modify with price and quantity): price × quantity.
 * - A MARKET order: the given reference price, else the best ask for a buy and the best bid for a
 *   sell. With neither, the order is refused (the notional is unknown).
 * - close_position: |net position| × the best bid (long) or the best ask (short). When that cannot
 *   be estimated, the close goes on.
 *
 * Prices refer to the YES side (docs.polymarket.us/concepts/orders). Amounts are exact decimals
 * (bigint with 9 decimal places), so "at the cap" is exact.
 */
import { ToolError } from './errors.ts';

export const DEFAULT_MAX_ORDER_USD = '50';
const PLACES = 9;
const SCALE = 10n ** BigInt(PLACES);
const DECIMAL = /^\d+(\.\d+)?$/;

/** A decimal string or number as units of 10^-9, or null when it is not a plain decimal. Pure. */
export function toUnits(value: unknown): bigint | null {
	if (typeof value === 'number' && !Number.isFinite(value)) return null;
	const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	if (!DECIMAL.test(text)) return null;
	const [whole = '0', fraction = ''] = text.split('.');
	if (fraction.length > PLACES) return null;
	return BigInt(whole) * SCALE + BigInt(fraction.padEnd(PLACES, '0') || '0');
}

/** Units as a decimal string with no trailing zeros ("12.5"). Pure. */
export function fromUnits(units: bigint): string {
	const sign = units < 0n ? '-' : '';
	const abs = units < 0n ? -units : units;
	const whole = abs / SCALE;
	const fraction = (abs % SCALE).toString().padStart(PLACES, '0').replace(/0+$/, '');
	return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** price × quantity in units. Pure. */
export function multiply(a: bigint, b: bigint): bigint {
	return (a * b) / SCALE;
}

/** The cap in units from the setting. Empty: the default. Throws `invalid` for a bad value. */
export function capUnits(setting: string | undefined): bigint {
	const raw = setting?.trim() ? setting.trim() : DEFAULT_MAX_ORDER_USD;
	const cap = toUnits(raw);
	if (cap === null || cap <= 0n) {
		throw new ToolError(
			'invalid',
			`The largest order setting "${raw}" is not a number above 0. Change it on the app page.`,
		);
	}
	return cap;
}

/** Throws `denied` when the notional is over the cap. */
export function checkCap(notional: bigint, cap: bigint, from: string): void {
	if (notional <= cap) return;
	throw new ToolError(
		'denied',
		`The order is about ${fromUnits(notional)} USD, over the largest order of ${fromUnits(cap)} USD. It was not sent. Ask for a smaller order, or raise the largest order on the app page.`,
		{ estimatedNotionalUsd: fromUnits(notional), capUsd: fromUnits(cap), estimatedFrom: from },
	);
}

/** An amount field: `{ value: "0.55" }`, a string, or a number, in units. Null when absent. Pure. */
export function amountUnits(value: unknown): bigint | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'object') return amountUnits((value as { value?: unknown }).value);
	return toUnits(value);
}

/** Best bid, best ask, and last price of a BBO answer (flat or under `marketData`). Pure. */
export function bboPrices(bbo: unknown): {
	bid: bigint | null;
	ask: bigint | null;
	last: bigint | null;
} {
	if (!bbo || typeof bbo !== 'object') return { bid: null, ask: null, last: null };
	const outer = bbo as Record<string, unknown>;
	const data =
		outer.marketData && typeof outer.marketData === 'object'
			? (outer.marketData as Record<string, unknown>)
			: outer;
	return {
		bid: amountUnits(data.bestBid),
		ask: amountUnits(data.bestAsk),
		last: amountUnits(data.lastTradePx) ?? amountUnits(data.lastTradePrice),
	};
}

/** The net quantity of a position, in units. Null when the answer has none. Pure. */
export function positionNet(position: unknown): bigint | null {
	if (!position || typeof position !== 'object') return null;
	const fields = position as Record<string, unknown>;
	for (const key of ['netPositionDecimal', 'netPosition', 'qtyAvailableDecimal', 'qtyAvailable']) {
		const raw = fields[key];
		if (raw === undefined || raw === null || raw === '') continue;
		const text = String(raw).trim();
		const negative = text.startsWith('-');
		const units = toUnits(negative ? text.slice(1) : text);
		if (units !== null) return negative ? -units : units;
	}
	return null;
}
