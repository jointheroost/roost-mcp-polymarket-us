/**
 * A small check of tool input against the JSON Schema subset that this server's tools use:
 * an object with typed properties (string, number, integer, boolean, array of strings), enums,
 * minimum, required names (with a hint that says where to get a missing one), and no other names.
 */
import { ToolError } from './errors.ts';

export interface PropertySchema {
	type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
	description: string;
	enum?: readonly string[];
	minimum?: number;
	maximum?: number;
	items?: { type: 'string' };
	maxLength?: number;
	/** Said after "<name> is required." when the input lacks this name. Not sent to clients. */
	hint?: string;
}

export interface ObjectSchema {
	type: 'object';
	properties: Record<string, PropertySchema>;
	required?: readonly string[];
	additionalProperties: false;
}

/** The input as an object of known names, or throws `invalid` with the first problem. */
export function checkInput(schema: ObjectSchema, input: unknown): Record<string, unknown> {
	const value = input ?? {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ToolError('invalid', 'The input must be an object.');
	}
	const record = value as Record<string, unknown>;
	for (const name of schema.required ?? []) {
		if (record[name] === undefined || record[name] === null || record[name] === '') {
			const hint = schema.properties[name]?.hint;
			throw new ToolError('invalid', `${name} is required.${hint ? ` ${hint}` : ''}`);
		}
	}
	const out: Record<string, unknown> = {};
	for (const [name, item] of Object.entries(record)) {
		const property = schema.properties[name];
		if (!property) {
			const takes = Object.keys(schema.properties).join(', ') || 'no inputs';
			throw new ToolError('invalid', `Unknown input "${name}". This tool takes: ${takes}.`);
		}
		if (item === undefined || item === null) continue;
		out[name] = checkProperty(name, property, item);
	}
	return out;
}

function checkProperty(name: string, property: PropertySchema, item: unknown): unknown {
	switch (property.type) {
		case 'string': {
			if (typeof item !== 'string') throw new ToolError('invalid', `${name} must be text.`);
			if (property.maxLength !== undefined && item.length > property.maxLength) {
				throw new ToolError('invalid', `${name} is too long.`);
			}
			if (property.enum) {
				// Any case is accepted; the tool gets the name as the schema spells it.
				const wanted = item.trim().toUpperCase();
				const member = property.enum.find((entry) => entry.toUpperCase() === wanted);
				if (member === undefined) {
					throw new ToolError('invalid', `${name} must be one of ${property.enum.join(', ')}.`);
				}
				return member;
			}
			return item.trim();
		}
		case 'number':
		case 'integer': {
			const number = typeof item === 'string' && item.trim() !== '' ? Number(item) : item;
			if (typeof number !== 'number' || !Number.isFinite(number)) {
				throw new ToolError('invalid', `${name} must be a number.`);
			}
			if (property.type === 'integer' && !Number.isInteger(number)) {
				throw new ToolError('invalid', `${name} must be a whole number.`);
			}
			if (property.minimum !== undefined && number < property.minimum) {
				throw new ToolError('invalid', `${name} must be at least ${property.minimum}.`);
			}
			if (property.maximum !== undefined && number > property.maximum) {
				throw new ToolError('invalid', `${name} must be at most ${property.maximum}.`);
			}
			return number;
		}
		case 'boolean': {
			if (typeof item !== 'boolean') throw new ToolError('invalid', `${name} must be true or false.`);
			return item;
		}
		case 'array': {
			if (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string')) {
				throw new ToolError('invalid', `${name} must be a list of text.`);
			}
			return item.map((entry: string) => entry.trim());
		}
	}
}
