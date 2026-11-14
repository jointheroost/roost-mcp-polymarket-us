/**
 * The short words of the tool inputs and the enums of the vendor (orders-schema.json, read
 * 2026-11-14). As in the reference server: `TIME_IN_FORCE_DAY` is refused (the official SDK has
 * no DAY member).
 */
import { ToolError } from './errors.ts';

export const INTENTS = ['BUY_LONG', 'SELL_LONG', 'BUY_SHORT', 'SELL_SHORT'] as const;
export const ORDER_TYPES = ['LIMIT', 'MARKET'] as const;
export const TIFS = ['GTC', 'GTD', 'IOC', 'FOK'] as const;

const TIF_ENUM: Record<(typeof TIFS)[number], string> = {
	GTC: 'TIME_IN_FORCE_GOOD_TILL_CANCEL',
	GTD: 'TIME_IN_FORCE_GOOD_TILL_DATE',
	IOC: 'TIME_IN_FORCE_IMMEDIATE_OR_CANCEL',
	FOK: 'TIME_IN_FORCE_FILL_OR_KILL',
};

const norm = (value: string) => value.trim().toUpperCase().replace(/[-\s]/g, '_');

/** `ORDER_INTENT_BUY_LONG` for "buy_long" or the full name. Throws `invalid`. */
export function mapIntent(value: string): string {
	const key = norm(value).replace(/^ORDER_INTENT_/, '');
	if ((INTENTS as readonly string[]).includes(key)) return `ORDER_INTENT_${key}`;
	throw new ToolError(
		'invalid',
		`Unknown intent "${value}". Use BUY_LONG, SELL_LONG, BUY_SHORT, or SELL_SHORT.`,
	);
}

/** `ORDER_TYPE_LIMIT` or `ORDER_TYPE_MARKET`. Throws `invalid`. */
export function mapOrderType(value: string): string {
	const key = norm(value).replace(/^ORDER_TYPE_/, '');
	if ((ORDER_TYPES as readonly string[]).includes(key)) return `ORDER_TYPE_${key}`;
	throw new ToolError('invalid', `Unknown order type "${value}". Use LIMIT or MARKET.`);
}

/** The time in force enum. DAY is refused. Throws `invalid`. */
export function mapTif(value: string): string {
	const key = norm(value);
	if (key === 'DAY' || key === 'TIME_IN_FORCE_DAY') {
		throw new ToolError('invalid', 'DAY is not supported. Use GTC, GTD, IOC, or FOK.');
	}
	if (key in TIF_ENUM) return TIF_ENUM[key as keyof typeof TIF_ENUM];
	if (Object.values(TIF_ENUM).includes(key)) return key;
	throw new ToolError('invalid', `Unknown time in force "${value}". Use GTC, GTD, IOC, or FOK.`);
}
