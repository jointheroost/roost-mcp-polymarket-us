/**
 * The compact answers of the read tools. Polymarket US answers are large: one search with 3 events
 * is about 200 KB, because each event holds every market with its rules text, images, and sides.
 * A compact answer keeps what a bot needs to answer and to call the next tool, and drops the
 * rest. `detail: "full"` skips all of this and gives the vendor's whole answer.
 *
 * Field meanings come from the OpenAPI copies in `openapi/` (read 2026-11-14):
 * - A position's `cost` is "Total cost basis". The vendor FAQ says the cost of a position includes
 *   the trading fee ("Why does my position look down right after I buy?"). It is the money spent
 *   on the whole position, not the price of one fill: `costBasisUsd`.
 * - `realized` is "Realized profit/loss": `realizedPnlUsd`.
 * - `cashValue` is "Unrealized PnL for the position": `unrealizedPnlUsd`. The vendor's name for it
 *   is misleading, so the compact answer uses the meaning.
 * - A trade's `price` is the fill price. Its `costBasis` is "Cost basis for the trade".
 * We do not compute a profit or loss of our own: the vendor gives both.
 */
import { fromUnits, toUnits } from './notional.ts';

type Json = Record<string, unknown>;

/** The most price points in a compact price history. */
export const MAX_HISTORY_POINTS = 48;

const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** A decimal as text, from a string or a number. */
const decimal = (value: unknown): string | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
/** The decimal string of an `Amount` ({ value, currency }). */
const amount = (value: unknown): string | undefined => (isObject(value) ? decimal(value.value) : undefined);
/** The name without the vendor's enum prefix: `MARKET_STATUS_OPEN` becomes `OPEN`. */
const strip = (prefix: string, value: unknown): string | undefined => {
	const name = text(value);
	return name?.startsWith(prefix) ? name.slice(prefix.length) : name;
};

/** The object without its undefined fields. */
function clean(value: Json): Json {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** The Yes and No prices of a market: its long side and its other side. */
function sidePrices(market: Json): { yesPrice?: string; noPrice?: string } {
	const sides = asArray(market.marketSides).filter(isObject);
	const yes = sides.find((side) => side.long === true);
	const no = sides.find((side) => side.long === false);
	let yesPrice = decimal(yes?.price);
	let noPrice = decimal(no?.price);
	if (yesPrice === undefined || noPrice === undefined) {
		// `outcomePrices` is JSON text such as `["0.4200","0.5800"]`, and is deprecated.
		try {
			const prices = JSON.parse(String(market.outcomePrices ?? '[]')) as unknown[];
			yesPrice ??= decimal(prices[0]);
			noPrice ??= decimal(prices[1]);
		} catch {
			// No usable prices: they stay out.
		}
	}
	return { yesPrice, noPrice };
}

/** One market: slug, name, state, prices, volume, end date. `question` only on request. */
export function compactMarket(market: Json, withQuestion: boolean): Json {
	const question = text(market.question);
	const title = text(market.title) ?? question;
	return clean({
		id: text(market.id),
		slug: text(market.slug),
		question: withQuestion ? question : undefined,
		title: withQuestion && title === question ? undefined : title,
		state: strip('MARKET_STATUS_', market.status),
		...sidePrices(market),
		volume: num(market.volume),
		volume24hr: num(market.volume24hr),
		endDate: text(market.endDate),
		minimumTradeQty: num(market.minimumTradeQty),
	});
}

/** The answer of get_market: `{ market }` with the compact market. */
export function compactMarketAnswer(answer: Json): Json {
	return isObject(answer.market) ? { market: compactMarket(answer.market, true) } : answer;
}

function compactEvent(event: Json, marketsPerEvent: number): Json {
	const markets = asArray(event.markets).filter(isObject);
	return clean({
		id: text(event.id),
		slug: text(event.slug),
		title: text(event.title),
		category: text(event.category),
		state: event.closed === true ? 'CLOSED' : event.active === false ? 'INACTIVE' : 'OPEN',
		endDate: text(event.endDate),
		volume: num(event.volume),
		volume24hr: num(event.volume24hr),
		marketCount: markets.length,
		markets: markets.slice(0, marketsPerEvent).map((market) => compactMarket(market, false)),
	});
}

/** The answer of search_markets: events, each with its first `marketsPerEvent` markets. */
export function compactSearch(answer: Json, marketsPerEvent: number): Json {
	return {
		...answer,
		events: asArray(answer.events)
			.filter(isObject)
			.map((event) => compactEvent(event, marketsPerEvent)),
	};
}

/** `cost / quantity` as a decimal, or undefined when either is not a plain positive decimal. */
function divide(cost: string | undefined, quantity: string | undefined): string | undefined {
	const top = toUnits(cost);
	const bottom = toUnits(quantity);
	if (top === null || bottom === null || bottom === 0n) return undefined;
	return fromUnits((top * 10n ** 9n) / bottom);
}

function compactPosition(slug: string, position: Json): Json {
	const metadata = isObject(position.marketMetadata) ? position.marketMetadata : {};
	const net = decimal(position.netPositionDecimal) ?? decimal(position.netPosition) ?? '0';
	const negative = net.startsWith('-');
	const quantity = negative ? net.slice(1) : net;
	const costBasis = amount(position.cost);
	const flat = toUnits(quantity) === 0n;
	return clean({
		marketSlug: text(metadata.slug) ?? slug,
		title: text(metadata.title),
		outcome: text(metadata.outcome),
		side: flat ? 'FLAT' : negative ? 'SHORT' : 'LONG',
		quantity,
		costBasisUsd: costBasis,
		avgPrice: divide(costBasis, quantity),
		realizedPnlUsd: amount(position.realized),
		unrealizedPnlUsd: amount(position.cashValue),
		quantityAvailable: decimal(position.qtyAvailableDecimal) ?? decimal(position.qtyAvailable),
		expired: typeof position.expired === 'boolean' ? position.expired : undefined,
		updatedAt: text(position.updateTime),
	});
}

/** The answer of get_positions: a list instead of a map, with plain cost fields. */
export function compactPositions(answer: Json): Json {
	const map = isObject(answer.positions) ? answer.positions : {};
	return clean({
		positions: Object.entries(map)
			.filter((entry): entry is [string, Json] => isObject(entry[1]))
			.map(([slug, position]) => compactPosition(slug, position)),
		nextCursor: text(answer.nextCursor),
		eof: typeof answer.eof === 'boolean' ? answer.eof : undefined,
	});
}

function compactActivity(activity: Json): Json {
	const type = strip('ACTIVITY_TYPE_', activity.type);
	if (isObject(activity.trade)) {
		const trade = activity.trade;
		return clean({
			type,
			tradeId: text(trade.id),
			marketSlug: text(trade.marketSlug),
			state: strip('TRADE_STATE_', trade.state),
			time: text(trade.createTime),
			price: amount(trade.price),
			quantity: decimal(trade.qtyDecimal) ?? decimal(trade.qty),
			taker: typeof trade.isAggressor === 'boolean' ? trade.isAggressor : undefined,
			costBasisUsd: amount(trade.costBasis),
			realizedPnlUsd: amount(trade.realizedPnl),
			// The OpenAPI copy has no side or intent on a trade. Keep them when the vendor sends them.
			intent: strip('ORDER_INTENT_', trade.intent),
			side: text(trade.side),
		});
	}
	if (isObject(activity.positionResolution)) {
		const resolution = activity.positionResolution;
		const before = isObject(resolution.beforePosition) ? resolution.beforePosition : {};
		const after = isObject(resolution.afterPosition) ? resolution.afterPosition : {};
		return clean({
			type,
			marketSlug: text(resolution.marketSlug),
			time: text(resolution.updateTime),
			side: strip('POSITION_RESOLUTION_SIDE_', resolution.side),
			tradeId: text(resolution.tradeId),
			quantityBefore: decimal(before.netPositionDecimal) ?? decimal(before.netPosition),
			quantityAfter: decimal(after.netPositionDecimal) ?? decimal(after.netPosition),
			realizedPnlUsd: amount(after.realized),
		});
	}
	if (isObject(activity.accountBalanceChange)) {
		const change = activity.accountBalanceChange;
		return clean({
			type,
			transactionId: text(change.transactionId),
			status: strip('ACCOUNT_BALANCE_CHANGE_STATUS_', change.status),
			amountUsd: amount(change.amount),
			time: text(change.updateTime) ?? text(change.createTime),
		});
	}
	return clean({ type });
}

/** The answer of get_activities: one flat row for each activity. */
export function compactActivities(answer: Json): Json {
	return clean({
		activities: asArray(answer.activities).filter(isObject).map(compactActivity),
		nextCursor: text(answer.nextCursor),
		eof: typeof answer.eof === 'boolean' ? answer.eof : undefined,
	});
}

function compactOrder(order: Json): Json {
	const metadata = isObject(order.marketMetadata) ? order.marketMetadata : {};
	return clean({
		orderId: text(order.id),
		marketSlug: text(order.marketSlug) ?? text(metadata.slug),
		title: text(metadata.title),
		intent: strip('ORDER_INTENT_', order.intent),
		type: strip('ORDER_TYPE_', order.type),
		state: strip('ORDER_STATE_', order.state),
		price: amount(order.price),
		quantity: num(order.quantity),
		filledQuantity: num(order.cumQuantity),
		remainingQuantity: num(order.leavesQuantity),
		avgFillPrice: amount(order.avgPx),
		tif: strip('TIME_IN_FORCE_', order.tif),
		goodTillTime: text(order.goodTillTime),
		createdAt: text(order.createTime),
	});
}

/** The answer of get_open_orders. */
export function compactOpenOrders(answer: Json): Json {
	return { orders: asArray(answer.orders).filter(isObject).map(compactOrder) };
}

/** The answer of get_price_history: at most 48 points as `{ t, yes, no }`, evenly spread. */
export function compactHistory(answer: Json): Json {
	const points = asArray(answer.history).filter(isObject);
	const shown =
		points.length <= MAX_HISTORY_POINTS
			? points
			: Array.from(
					{ length: MAX_HISTORY_POINTS },
					(_, at) => points[Math.round((at * (points.length - 1)) / (MAX_HISTORY_POINTS - 1))] as Json,
				);
	return {
		points: points.length,
		history: shown.map((point) => ({ t: point.timestamp, yes: point.longPrice, no: point.shortPrice })),
	};
}
