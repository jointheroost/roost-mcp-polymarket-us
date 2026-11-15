# Polymarket US for Roost

An MCP server for your own [Polymarket US](https://polymarket.us) account. It is an official Roost server: Roost downloads the release file from this repository, checks its SHA-256, and runs it on your hub with your own key. Your key stays on your hub. It never goes to Roost.

Polymarket US is the CFTC-regulated exchange at `api.polymarket.us`. This is not the international Polymarket (Polygon CLOB).

## Set up in Roost

1. Make a key. Open the Polymarket US app, make an account, and finish identity verification. Then open [polymarket.us/developer](https://polymarket.us/developer), sign in the same way as in the app, and click to create a key. Copy the **Key ID** and the **Secret key**. The secret key is shown only once.
2. In Roost, open **Marketplace**, find **Polymarket US** (it has the **By Roost** chip), and click **Set up**.
3. Paste the Key ID and the Secret key. Keep **Largest order (USD)** at 50, or change it.
4. Click **Connect**. Roost downloads the server, checks it, starts it, and checks the key with `get_balances`. A key that Polymarket US refuses is not saved.

The money tools are on, as other tools are, and they follow each bot's access: a bot with "Ask first" asks you, and a bot with Full access does not. The switch **Ask every time** on the app page (off by default) makes each money tool ask you before each call, also for a bot with Full access and in saved automations. To stop one tool, turn it off on the app page.

## Tools

| Tool | What it does | Key |
| --- | --- | --- |
| `search_markets` | Search events and markets by words | No |
| `get_market` | One market by `market_slug` | No |
| `get_order_book` | The order book and stats of a market (`market_slug`) | No |
| `get_price_history` | YES and NO prices over time (`market_slug`) | No |
| `get_balances` | Cash balance and buying power | Yes |
| `get_positions` | Positions, with cost basis and profit and loss | Yes |
| `get_activities` | Trades, resolutions, deposits, withdrawals | Yes |
| `get_open_orders` | Open orders | Yes |
| `get_order` | One order by its ID | Yes |
| `preview_order` | Check an order and its expected cost. Sends no order | Yes |

### Names and answer size

Every tool that takes a market takes `market_slug`. Get it from `search_markets`. An order ID is `order_id`, a page size is `limit`, and a page of account lists is `cursor`.

`search_markets`, `get_market`, `get_positions`, `get_activities`, `get_open_orders` and `get_price_history` return a compact answer by default. A compact answer keeps the fields that a bot needs to answer and to call the next tool, and drops the repeated market objects, the rules text and the image URLs. Give `detail: "full"` for the whole answer of Polymarket US. About sizes: `search_markets` with `limit: 3` is about 2 KB (the whole answer is more than 200 KB), and `get_activities` with `limit: 5` is about 1 KB.

- `search_markets` shows the first 3 markets of each event. Each event has `marketCount`. Use `markets_per_event` to see more.
- `get_price_history` takes `interval` (default `1D`), or `start` and `end` in Unix seconds, not both. A compact answer has at most 48 points, as `{ t, yes, no }`.

### Cost and profit and loss

Polymarket US gives these fields, and the compact answer names them for what they mean:

| Field | Meaning |
| --- | --- |
| `costBasisUsd` of a position | The total cost of the position as Polymarket US counts it. It includes the trading fee. It is not the price of one fill. |
| `avgPrice` | `costBasisUsd` divided by `quantity`. This server does that one division. |
| `realizedPnlUsd` | The vendor's `realized`: realized profit and loss. |
| `unrealizedPnlUsd` | The vendor's `cashValue`, which its OpenAPI describes as "Unrealized PnL for the position". |
| `price` of a trade | The fill price. |
| `costBasisUsd` of a trade | The vendor's cost basis for that trade, fee included. |

So a trade's `costBasisUsd / quantity` can be a little above its `price`. This server does not compute its own profit and loss.

### Money tools

These place, change, or cancel live orders with real money.

| Tool | What it does |
| --- | --- |
| `place_order` | Place a LIMIT or MARKET order |
| `modify_order` | Change the price, quantity, or time in force of an open order |
| `cancel_order` | Cancel one open order |
| `cancel_all_orders` | Cancel every open order, or every open order in one market |
| `close_position` | Close the whole position in one market at the market price |

Orders that this server sends carry `MANUAL_ORDER_INDICATOR_AUTOMATIC`, so Polymarket US can see that a program sent them.

## Checks before an order

- **Largest order.** An order whose estimated notional is over the largest order is refused here and never sent. At the largest order is allowed.
  - LIMIT (and `modify_order` with a price and a quantity): price × quantity.
  - MARKET: the price that you give, else the best ask for a buy and the best bid for a sell. With neither, the order is refused.
  - `close_position`: |net position| × the best bid (long) or the best ask (short). When that cannot be estimated, the close goes on.
  - Prices are for the YES side, from 0 to 1 USD.
- **Orders a minute.** At most 10 orders (place, modify, close) in one minute. A cancel is never limited.
- **Rate limit.** Polymarket US allows 25 requests a second for each address. The server keeps 40 ms between requests. A read that gets a 429 waits 1 second, then 2 seconds, and tries again. An order that gets a 429 is not sent again.

Rule 5.2(i) of the Polymarket US Rulebook asks automated trading systems for "order throttles, price collars, and kill switches". The largest order and the orders a minute limit are the throttles. `cancel_all_orders` is the kill switch, and turning a money tool off in Roost stops it at once. There is no price collar yet: the server only checks that a price is above 0 and below 1.

## Errors

A failed call returns `isError: true` and `structuredContent.error` with `class` and `message`:

| Class | Meaning |
| --- | --- |
| `auth` | The key is missing, refused, or the hub clock is off ("Check the clock of the hub.") |
| `invalid` | The input or the order is wrong, or Polymarket US refused it (with its message) |
| `denied` | A check of this server refused it, such as the largest order |
| `transient` | Polymarket US did not answer or was slow. Try again |
| `limit` | Too many requests or orders. Wait, then try again |
| `failed` | Anything else |

No message, result, or log carries the secret key.

## Environment

Roost sets these when it starts the server. You need them only to run it by hand.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POLYMARKET_KEY_ID` | none | The Key ID |
| `POLYMARKET_SECRET_KEY` | none | The Secret key (base64) |
| `POLYMARKET_US_MAX_ORDER_USD` | `50` | The largest order in USD |
| `POLYMARKET_US_MAX_ORDERS_PER_MINUTE` | `10` | Orders in one minute |

With no key, only the four public tools work.

## Develop

```bash
bun install
bun test            # against a fake Polymarket US; no network, no real key
bun run typecheck
bun run build       # dist/roost-mcp-polymarket-us.js, one file, no install step
bun run drift       # compare the vendor's public OpenAPI files with openapi/
```

The server has no runtime dependencies. `@modelcontextprotocol/sdk` is only for the stdio test.

## Release

1. Set `version` in `package.json` (for example `0.1.1`), then push the tag `v0.1.1`. Add a line to `CHANGELOG.md`.
2. The Release workflow tests, builds, and publishes `roost-mcp-polymarket-us.js` and `roost-mcp-polymarket-us.js.sha256` as release assets.
3. In the Roost repository, set the Polymarket US row of `app-catalog.json` to the new tag and the SHA-256 from the `.sha256` file. Each hub downloads the new file the next time it starts the server.

## Upkeep

The vendor's API can change. The Vendor API drift workflow runs each Monday and fails when the public OpenAPI files differ from `openapi/`. Read the [changelog](https://docs.polymarket.us/changelog), fix the tools, then run `bun scripts/drift.ts --write`. `SOURCE.md` lists each vendor page and the date it was read.
