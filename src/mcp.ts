/**
 * A small MCP server over stdio (newline-delimited JSON-RPC 2.0, MCP base protocol): initialize,
 * ping, tools/list, and tools/call. No dependency: the release file is this repository's own code.
 */
import packageJson from '../package.json' with { type: 'json' };
import type { ObjectSchema } from './check.ts';
import { redact, ToolError } from './errors.ts';
import { runTool, TOOLS, type ToolContext } from './tools.ts';

export const SERVER_NAME = 'roost-mcp-polymarket-us';
/** The version of package.json: the release tag without the v. */
export const SERVER_VERSION: string = packageJson.version;
/** Protocol versions that this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const INSTRUCTIONS =
	'Polymarket US (api.polymarket.us), the CFTC-regulated exchange. Prices are for the YES side, from 0 to 1 USD. ' +
	'Public market tools work with no key. Account tools need the key. place_order, modify_order, cancel_order, ' +
	'cancel_all_orders, and close_position move real money; use preview_order first. An order over the largest ' +
	'order setting is refused and not sent.';

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

type Reply = Record<string, unknown>;

/** The input schema for clients: no `hint`, which is a word of this server's own errors. Pure. */
function publicSchema(schema: ObjectSchema): ObjectSchema {
	const properties = Object.fromEntries(
		Object.entries(schema.properties).map(([name, { hint: _hint, ...rest }]) => [name, rest]),
	);
	return { ...schema, properties };
}

/** The tool list as MCP gives it. Pure. */
export function toolList(): Reply[] {
	return TOOLS.map((tool) => ({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: publicSchema(tool.inputSchema),
		annotations: {
			title: tool.title,
			readOnlyHint: tool.readOnly,
			destructiveHint: tool.money,
			idempotentHint: tool.readOnly,
			openWorldHint: true,
		},
	}));
}

/** The answer to one message, or null for a notification. */
export async function handleMessage(
	message: JsonRpcMessage,
	context: ToolContext,
	secrets: readonly string[],
): Promise<Reply | null> {
	const id = message.id;
	if (id === undefined || id === null) return null;
	const ok = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
	const fail = (code: number, text: string): Reply => ({
		jsonrpc: '2.0',
		id,
		error: { code, message: text },
	});
	switch (message.method) {
		case 'initialize': {
			const asked = String(message.params?.protocolVersion ?? '');
			const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
				? asked
				: PROTOCOL_VERSIONS[1];
			return ok({
				protocolVersion: version,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, title: 'Polymarket US', version: SERVER_VERSION },
				instructions: INSTRUCTIONS,
			});
		}
		case 'ping':
			return ok({});
		case 'tools/list':
			return ok({ tools: toolList() });
		case 'tools/call': {
			const name = String(message.params?.name ?? '');
			try {
				const value = await runTool(name, message.params?.arguments ?? {}, context);
				return ok({
					content: [{ type: 'text', text: JSON.stringify(value) }],
					structuredContent: value,
				});
			} catch (error) {
				const known = error instanceof ToolError;
				const text = redact(
					known ? error.message : 'The tool failed in the Polymarket US server.',
					secrets,
				);
				const detail = {
					error: {
						class: known ? error.errorClass : 'failed',
						message: text,
						...(known && error.status !== null ? { status: error.status } : {}),
						...(known ? error.details : {}),
					},
				};
				return ok({
					content: [{ type: 'text', text }],
					structuredContent: detail,
					isError: true,
				});
			}
		}
		default:
			return fail(-32601, `Method not found: ${message.method}`);
	}
}

/** Read messages from stdin and write answers to stdout, one JSON per line. */
export async function serveStdio(context: ToolContext, secrets: readonly string[]): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = '';
	const write = (reply: Reply) => process.stdout.write(`${JSON.stringify(reply)}\n`);
	const handleLine = async (line: string) => {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
			return;
		}
		const reply = await handleMessage(message, context, secrets);
		if (reply) write(reply);
	};
	for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let end = buffer.indexOf('\n');
		while (end >= 0) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			// Calls run side by side; each answer carries its own id.
			if (line) void handleLine(line);
			end = buffer.indexOf('\n');
		}
	}
}
