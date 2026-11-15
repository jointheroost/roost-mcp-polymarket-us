# Changelog

## 0.1.1

- One name for a market: every tool that takes a market takes `market_slug`. `get_market`, `get_order_book` and `get_price_history` took `slug` before, and that name is gone. A missing argument says which one to give: "market_slug is required. Get it from search_markets." An unknown argument lists what the tool takes.
- Small answers by default for `search_markets`, `get_market`, `get_positions`, `get_activities`, `get_open_orders` and `get_price_history`. `detail: "full"` gives the whole answer. `search_markets` with `limit: 3` went from more than 200 KB to about 2 KB. `search_markets` takes `markets_per_event` (default 3).
- Plain cost fields. A position has `costBasisUsd` (the vendor's total cost basis, trading fee included), `avgPrice`, `realizedPnlUsd` and `unrealizedPnlUsd`. A trade has `price` and `costBasisUsd`.
- `get_price_history` sends the request that the vendor documents: a fixed interval with its own fidelity, or a custom range with fidelity 1 and no interval. Before, a custom range was sent together with a fixed interval, which the vendor refuses with HTTP 400. `fidelity` is no longer an input. An unknown market gives an empty history and a note.
- Enum inputs (`detail`, `interval`, `intent`, `type`, `tif`) accept any case.
- Tool descriptions say what each tool returns.

## 0.1.0

First release: 15 tools, the largest order check, the orders a minute limit.
