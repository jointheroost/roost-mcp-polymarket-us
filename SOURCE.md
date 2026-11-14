# Sources

Every page was read on 2026-11-14, with no account and no key.

## API

| Fact | Source |
| --- | --- |
| Two hosts: `https://api.polymarket.us` (orders, portfolio, account; each request needs a key) and `https://gateway.polymarket.us` (public market data; "No API key needed") | https://docs.polymarket.us/api-reference/introduction |
| The key: a Key ID and a Secret key from `polymarket.us/developer`, after identity verification. "Your secret key is shown only once." | https://docs.polymarket.us/api-reference/authentication |
| Three headers: `X-PM-Access-Key`, `X-PM-Timestamp` (milliseconds), `X-PM-Signature`. "The signature is built by combining the timestamp, HTTP method, and path, then signing it with your secret key. Timestamps must be within 30 seconds of server time." Python sample: Ed25519 from `base64decode(secret)[:32]` | same page |
| The path that is signed has no query string: `createAuthHeaders(keyId, secretKey, method, url.pathname)` | official TypeScript SDK `polymarket-us` 0.1.1, `dist/index.mjs` (npm tarball, read, not installed) |
| "The Retail API has a general limit of 25 requests/s". Per source IP. 429: "Stop immediately, wait at least 1 second, then retry with exponential backoff" | https://docs.polymarket.us/api-reference/rate-limits |
| "Order Processing Max Delay Exceeded" (before: "Global Rate Limit Exceeded") is a latency reject, "not an actual rate limit ... you may resubmit" | same page |
| Prices refer to the YES side; one instrument per market | https://docs.polymarket.us/concepts/orders |
| OpenAPI files (copies in `openapi/`): markets, orders, portfolio, price-history, search | https://docs.polymarket.us/llms.txt, "OpenAPI Specs" |
| Changelog | https://docs.polymarket.us/changelog |

One public, unsigned read of the real gateway on 2026-11-14: `GET /v1/search?query=fed&limit=1` answered 200 with one event ("Fed Funds Rate at the End of 2027?", 9 markets).

## Terms

| Document | What it says for software that holds a person's own key |
| --- | --- |
| Individual Participant and Clearing Member Agreement (version 2026.08.06), https://polymarketexchange.com/files/legal/latest/participant-agreement | 18: "You are solely responsible, at your own risk and expense, for acquiring, installing, and maintaining all equipment, hardware, and software ... required to connect to the System. You are responsible for keeping your systems ... secure at all times from unauthorized access or use." 19: "You shall comply with all conformance tests and procedures required by Polymarket US when connecting to the System via API. You shall not access or use the System in a live production environment unless and until you have received written approval to do so from Polymarket US." 24: "You shall not, under any circumstances, share, disclose, provide or otherwise make available your login credentials to any other person or entity." |
| Polymarket US Rulebook (2026-09-30), https://polymarketexchange.com/files/legal/latest/rulebook | 5.2(h): "Participants shall maintain an electronic audit trail capturing order entry, modification, cancellation, and execution timestamps". 5.2(i): "Participants utilizing automated trading systems must implement pre-trade risk controls including order throttles, price collars, and kill switches." 5.3(c): "adequate controls are in place to prevent excessive messaging". |

Reading (not legal advice): the person runs this server on their own hub, with their own key, as their own software (Agreement 18). The key is not given to another person or entity: Roost never receives it (Agreement 24). A hosted copy run by someone else would need a new reading. Rule 5.2(i) is why the server has the largest order check, the orders a minute limit, and `cancel_all_orders`.
