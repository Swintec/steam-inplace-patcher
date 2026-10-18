// An independent AES fixture catches truncated final blocks in steam-crypto.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const SteamCrypto = require('@doctormckay/steam-crypto');
const {Hashing} = require('@doctormckay/stdlib');
const {unzip} = require('steam-user/components/cdn_compression.js');

function encrypt(data, key, iv) {
	const ecb = crypto.createCipheriv('aes-256-ecb', key, null);
	ecb.setAutoPadding(false);
	const cbc = crypto.createCipheriv('aes-256-cbc', key, iv);
	return Buffer.concat([ecb.update(iv), ecb.final(), cbc.update(data), cbc.final()]);
}

(async () => {
	const key = crypto.randomBytes(32), iv = crypto.randomBytes(16);
	for (const size of [1, 15, 16, 17, 37, 10001, 1048576]) {
		const data = crypto.randomBytes(size);
		assert.deepEqual(SteamCrypto.symmetricDecrypt(encrypt(data, key, iv), key), data,
			`Steam AES decryption must retain all ${size} bytes on ${process.version}`);
	}
	const data = crypto.randomBytes(1048576);
	const header = Buffer.alloc(8), footer = Buffer.alloc(15);
	header.write('VSZa');
	header.writeUInt32LE(Hashing.crc32(data), 4);
	footer.writeUInt32LE(Hashing.crc32(data));
	footer.writeUInt32LE(data.length, 4);
	footer.write('zsv', 12);
	const frame = Buffer.concat([header, zlib.zstdCompressSync(data), footer]);
	const decrypted = SteamCrypto.symmetricDecrypt(encrypt(frame, key, iv), key);
	assert.deepEqual(decrypted, frame);
	assert.deepEqual(await unzip(decrypted), data);
	console.log(`Steam AES and encrypted Zstd chunk regression checks OK (${process.version})`);
})().catch(err => { console.error(err); process.exitCode = 1; });
