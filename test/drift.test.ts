import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { surface } from '../scripts/drift.ts';

const copy = () =>
	JSON.parse(readFileSync(join(import.meta.dir, '..', 'openapi', 'orders-schema.json'), 'utf8'));

test('the drift check sees a new body field, a new enum value, and a removed operation', () => {
	const before = surface(copy());
	const doc = copy();
	doc.components.schemas.CreateOrderRequest.properties.newField = { type: 'string' };
	doc.components.schemas.OrderType.enum.push('ORDER_TYPE_STOP');
	delete doc.paths['/v1/order/close-position'];
	const after = surface(doc);
	const added = [...after].filter((line) => !before.has(line));
	const removed = [...before].filter((line) => !after.has(line));
	expect(added).toContain('POST /v1/orders body.newField');
	expect(added.some((line) => line.includes('ORDER_TYPE_STOP'))).toBe(true);
	expect(removed).toContain('POST /v1/order/close-position');
});

test('the same file gives the same surface', () => {
	expect([...surface(copy())]).toEqual([...surface(copy())]);
});
