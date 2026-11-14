import { describe, expect, test } from 'bun:test';
import { createSigner, KeyFormatError, seedOf } from '../src/sign.ts';
import { makeTestKey } from './fake-polymarket-us.ts';

describe('the request signature', () => {
	test('signs timestamp + method + path with Ed25519, and the public key verifies it', async () => {
		const key = await makeTestKey();
		const signer = await createSigner(key.keyId, key.secretKey, () => 1_731_542_400_123);
		const headers = await signer.sign('get', '/v1/portfolio/positions');
		expect(headers['X-PM-Access-Key']).toBe(key.keyId);
		expect(headers['X-PM-Timestamp']).toBe('1731542400123');
		const message = new TextEncoder().encode('1731542400123GET/v1/portfolio/positions');
		const signature = Uint8Array.from(atob(headers['X-PM-Signature']), (c) => c.charCodeAt(0));
		expect(signature.length).toBe(64);
		expect(await crypto.subtle.verify('Ed25519', key.publicKey, signature, message)).toBe(true);
		const other = new TextEncoder().encode('1731542400123GET/v1/account/balances');
		expect(await crypto.subtle.verify('Ed25519', key.publicKey, signature, other)).toBe(false);
	});

	test('takes a 32-byte seed as well as the 64-byte secret key', async () => {
		const key = await makeTestKey();
		const seedOnly = btoa(String.fromCharCode(...seedOf(key.secretKey)));
		const a = await (await createSigner('k', key.secretKey, () => 5)).sign('GET', '/x');
		const b = await (await createSigner('k', seedOnly, () => 5)).sign('GET', '/x');
		expect(a['X-PM-Signature']).toBe(b['X-PM-Signature']);
	});

	test('refuses a secret that is not base64 or has the wrong length', () => {
		expect(() => seedOf('not base64 !!')).toThrow(KeyFormatError);
		expect(() => seedOf(btoa('short'))).toThrow(KeyFormatError);
	});
});
