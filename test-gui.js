const assert = require('node:assert/strict');
const {once} = require('node:events');
const vm = require('node:vm');
const gui = require('./gui.js');

(async () => {
	const server = gui.start({openBrowser: false});
	try {
		await once(server, 'listening');
		const base = `http://127.0.0.1:${server.address().port}`;
		const status = async () => (await fetch(base + '/status')).json();
		gui.setTotals(10, 100, 100);
		gui.add('download', 10); gui.add('patch', 100);
		const before = await status();
		assert.equal(before.inst.total, 100);
		assert.equal(before.dl.wDone + before.inst.wDone, before.dl.wTotal + before.inst.wTotal);
		gui.setVerification({active: true}); gui.add('verify', 30);
		const during = await status();
		assert.deepEqual(during.inst, before.inst, 'Verification must not change the main bar');
		assert.equal(during.verify.done, 30);
		const elements = new Map();
		const document = {getElementById: id => {
			if (!elements.has(id)) elements.set(id, {style: {}, classList: {toggle() {}}});
			return elements.get(id);
		}};
		const html = await (await fetch(base)).text();
		const context = {document, fetch: async () => ({json: async () => during}), setTimeout() {}};
		await vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1] + '\ntick();', context);
		assert.equal(elements.get('pct').textContent, '100.0%');
		assert.match(elements.get('verifytext').textContent, /Verifying/);
		assert.equal((await fetch(base + '/skip-verification', {method: 'POST'})).status, 200);
		assert.equal(gui.skipVerification(), true);
		assert.equal((await status()).verify.skipped, true);
		gui.set({finished: true});
		assert.equal((await fetch(base + '/skip-verification', {method: 'POST'})).status, 409);
		console.log('GUI bar, verification display and skip endpoint checks OK');
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
})().catch(err => { console.error(err); process.exitCode = 1; });
