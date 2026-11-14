/**
 * The request signature of the Polymarket US API (docs.polymarket.us/api-reference/authentication,
 * read 2026-11-14): Ed25519 over `${timestamp}${METHOD}${path}`, base64. The path has no query
 * string (the official TypeScript SDK 0.1.1 signs `url.pathname`). The secret key is base64; its
 * first 32 bytes are the Ed25519 seed (the vendor's Python sample and the SDK both cut it there).
 */

/** The PKCS#8 head of an Ed25519 private key (RFC 8410): the 32-byte seed follows it. */
const PKCS8_ED25519_HEAD = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export class KeyFormatError extends Error {}

/** The 32-byte seed of a secret key in base64 (32 or 64 bytes). Throws `KeyFormatError`. */
export function seedOf(secretKey: string): Uint8Array {
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(secretKey.trim()), (char) => char.charCodeAt(0));
	} catch {
		throw new KeyFormatError('The secret key is not base64.');
	}
	if (bytes.length !== 32 && bytes.length !== 64) {
		throw new KeyFormatError('The secret key has the wrong length.');
	}
	return bytes.slice(0, 32);
}

/** A WebCrypto signing key from the secret key. */
export async function importSecretKey(secretKey: string): Promise<CryptoKey> {
	const seed = seedOf(secretKey);
	const pkcs8 = new Uint8Array(PKCS8_ED25519_HEAD.length + seed.length);
	pkcs8.set(PKCS8_ED25519_HEAD, 0);
	pkcs8.set(seed, PKCS8_ED25519_HEAD.length);
	return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

function toBase64(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) text += String.fromCharCode(byte);
	return btoa(text);
}

/** The three headers of one request. */
export interface SignedHeaders {
	'X-PM-Access-Key': string;
	'X-PM-Timestamp': string;
	'X-PM-Signature': string;
}

export interface Signer {
	sign(method: string, path: string): Promise<SignedHeaders>;
}

/** A signer for one key. `now` is the clock in milliseconds (tests move it). */
export async function createSigner(
	keyId: string,
	secretKey: string,
	now: () => number = Date.now,
): Promise<Signer> {
	const key = await importSecretKey(secretKey);
	const id = keyId.trim();
	return {
		async sign(method, path) {
			const timestamp = String(Math.trunc(now()));
			const message = new TextEncoder().encode(`${timestamp}${method.toUpperCase()}${path}`);
			const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, message));
			return {
				'X-PM-Access-Key': id,
				'X-PM-Timestamp': timestamp,
				'X-PM-Signature': toBase64(signature),
			};
		},
	};
}
