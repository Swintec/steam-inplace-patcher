// In-place updater for Steam games.
// Rewrites changed files in place instead of staging a full copy, so a huge game needs a few GB free instead of its full size.
//
//   steam-inplace-patcher.exe                 pick a game in the browser and update it
//   node patcher.js plan   <appid>            offline: what would change
//   node patcher.js apply  <appid>            log in, download new chunks, patch in place, verify, update Steam's app manifest
//   node patcher.js verify <appid>            check every changed file chunk by chunk and repair mismatches
//   node patcher.js list                      installed games
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {execSync} = require('child_process');
const {loadManifest, buildPlan, schedule} = require('./plan.js');
const gui = require('./gui.js');
const {verifyFiles} = require('./verification.js');

// as a single .exe, keep state next to the exe
const HERE = require('node:sea').isSea() ? path.dirname(process.execPath) : __dirname;
const debug = require('./debug.js').createDebug(process.argv.slice(2), HERE);
if (debug.enabled) {
	console.log('Debug log:', debug.file);
	debug.write('startup', {node: process.version, platform: process.platform, arch: process.arch, sea: require('node:sea').isSea()});
	debug.instrumentCompression(require('steam-user/components/cdn_compression.js'));
	process.on('warning', e => debug.error('warning', e));
}
const STEAM = findSteam();
const STATE = path.join(HERE, 'state');
const TOKEN = path.join(STATE, 'refresh-token.txt');

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const gib = n => (n / 2 ** 30).toFixed(2) + ' GiB';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => {
	console.log(new Date().toLocaleTimeString(), ...a);
	debug.write('message', {message: a.join(' ')});
	gui.set({message: a.join(' ')});
};
const verificationLog = message => {
	console.log(new Date().toLocaleTimeString(), message);
	debug.write('message', {message});
	gui.setVerification({message});
};

function findSteam() {
	try {
		const out = execSync('reg query HKCU\\Software\\Valve\\Steam /v SteamPath', {encoding: 'utf8'});
		const p = out.match(/SteamPath\s+REG_SZ\s+(.+)/)[1].trim().replace(/\//g, '\\');
		if (fs.existsSync(p)) return p;
	} catch (e) {}
	return 'C:\\Program Files (x86)\\Steam';
}

function libraries() {
	const vdf = `${STEAM}\\steamapps\\libraryfolders.vdf`;
	const libs = fs.existsSync(vdf) ? [...fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)].map(m => m[1].replace(/\\\\/g, '\\')) : [];
	const seen = new Set();
	return [STEAM, ...libs].filter(l => {
		const k = l.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return fs.existsSync(`${l}\\steamapps`);
	});
}

// ---------- installed games / app manifests ----------

function parseAcf(file) {
	const text = fs.readFileSync(file, 'utf8');
	const field = name => (text.match(new RegExp(`"${name}"\\s+"([^"]*)"`)) || [])[1];
	const depots = [];
	const block = text.match(/"InstalledDepots"\s*\{([\s\S]*?)\n\t\}/);
	if (block) {
		for (const m of block[1].matchAll(/"(\d+)"\s*\{\s*"manifest"\s+"(\d+)"\s*"size"\s+"(\d+)"/g)) {
			depots.push({depot: Number(m[1]), manifest: m[2], size: Number(m[3])});
		}
	}
	const beta = (text.match(/"UserConfig"\s*\{[^}]*?"BetaKey"\s+"([^"]*)"/) || [])[1];
	return {
		text, file, depots,
		app: Number(field('appid')),
		name: field('name'),
		installdir: field('installdir'),
		buildid: field('buildid'),
		target: field('TargetBuildID'),
		stateFlags: Number(field('StateFlags') || 0),
		sizeOnDisk: Number(field('SizeOnDisk') || 0),
		branch: beta || 'public',
	};
}

function listGames() {
	const games = [];
	for (const lib of libraries()) {
		for (const n of fs.readdirSync(`${lib}\\steamapps`).filter(n => /^appmanifest_\d+\.acf$/.test(n))) {
			try {
				const a = parseAcf(`${lib}\\steamapps\\${n}`);
				if (!a.depots.length) continue;
				games.push({
					app: a.app, name: a.name, lib, gb: +(a.sizeOnDisk / 2 ** 30).toFixed(1),
					// StateFlags bit 2 = update required (Steam already knows about a newer build)
					updatePending: !!(a.stateFlags & 2) || (a.target && a.target !== '0' && a.target !== a.buildid),
				});
			} catch (e) {}
		}
	}
	return games.sort((a, b) => (b.updatePending - a.updatePending) || b.gb - a.gb);
}

function openGame(app) {
	for (const lib of libraries()) {
		const file = `${lib}\\steamapps\\appmanifest_${app}.acf`;
		if (fs.existsSync(file)) {
			const acf = parseAcf(file);
			return {...acf, lib, dir: `${lib}\\steamapps\\common\\${acf.installdir}`, state: path.join(STATE, String(app))};
		}
	}
	throw new Error(`App ${app} is not installed in any Steam library`);
}

// ---------- Steam process ----------

function steamRunning() {
	try {
		return /steam\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq steam.exe" /NH', {encoding: 'utf8'}));
	} catch (e) {
		return false;
	}
}

// Steam must not touch the game (or its app manifest) while we patch
async function closeSteam() {
	if (!steamRunning()) return;
	log('Closing Steam...');
	try {
		execSync(`"${STEAM}\\steam.exe" -shutdown`, {stdio: 'ignore', timeout: 15000});
	} catch (e) {}
	for (let i = 0; i < 30 && steamRunning(); i++) await sleep(1000);
	if (steamRunning()) {
		log('Steam did not exit in time, forcing it to close...');
		try { execSync('taskkill /F /IM steam.exe', {stdio: 'ignore'}); } catch (e) {}
		for (let i = 0; i < 10 && steamRunning(); i++) await sleep(1000);
	}
	if (steamRunning()) throw new Error('Could not close Steam; exit it via the tray icon and start again');
	await sleep(2000);
}

function progress(label, total) {
	let doneBytes = 0, last = 0;
	const start = Date.now();
	return {
		add(n) {
			doneBytes += n;
			gui.add(label, n);
			const now = Date.now();
			if (now - last < 3000 && doneBytes < total) return;
			last = now;
			const rate = doneBytes / Math.max(1, (now - start) / 1000);
			const eta = rate > 0 ? Math.round((total - doneBytes) / rate / 60) : '?';
			const message = `${label}: ${gib(doneBytes)} / ${gib(total)} (${(100 * doneBytes / total).toFixed(1)}%), ${(rate / 2 ** 20).toFixed(0)} MiB/s, ~${eta} min left`;
			if (label === 'verify') verificationLog(message);
			else log(message);
		},
	};
}

// ---------- Steam login ----------

async function login() {
	const SteamUser = require('steam-user');
	const client = new SteamUser({enablePicsCache: false, autoRelogin: true});
	client.on('error', e => {
		debug.error('steam-error', e);
		log('Steam error:', e.message);
	});

	let refreshToken = fs.existsSync(TOKEN) ? fs.readFileSync(TOKEN, 'utf8').trim() : null;
	if (!refreshToken) refreshToken = await qrLogin();

	await new Promise((resolve, reject) => {
		client.once('loggedOn', resolve);
		client.once('error', reject);
		client.logOn({refreshToken, logonID: 0x41524B});
	});
	client.on('refreshToken', t => fs.writeFileSync(TOKEN, t));
	log('Logged in to Steam as', client.steamID.getSteamID64());
	return client;
}

async function qrLogin() {
	const {LoginSession, EAuthTokenPlatformType} = require('steam-session');
	const qrcode = require('qrcode-terminal');
	const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
	session.loginTimeout = 5 * 60 * 1000;
	const {qrChallengeUrl} = await session.startWithQR();
	console.log('\nScan this QR code with the Steam app on your phone (Steam Guard > scan QR code):\n');
	qrcode.generate(qrChallengeUrl, {small: true});
	await gui.showQr(qrChallengeUrl);
	gui.set({message: 'Log in: scan the QR code with the Steam app on your phone'});
	return new Promise((resolve, reject) => {
		session.on('remoteInteraction', () => log('QR scanned, confirm the login in the Steam app...'));
		session.on('authenticated', () => {
			gui.showQr(null);
			fs.writeFileSync(TOKEN, session.refreshToken);
			resolve(session.refreshToken);
		});
		session.on('timeout', () => reject(new Error('QR login timed out, run again')));
		session.on('error', reject);
	});
}

// ---------- manifests ----------

// latest manifest id per installed depot, from Steam (online) or the newest one in depotcache (offline)
async function latestManifests(client, game) {
	const latest = new Map();
	let buildid = game.target;
	if (client) {
		const {apps} = await client.getProductInfo([game.app], [], true);
		const info = apps[game.app] && apps[game.app].appinfo;
		if (!info || !info.depots) throw new Error(`No depot info for app ${game.app}; do you own it?`);
		const branch = info.depots.branches && info.depots.branches[game.branch];
		if (!branch) throw new Error(`Branch "${game.branch}" not found for app ${game.app}`);
		buildid = branch.buildid;
		for (const d of game.depots) {
			const m = info.depots[d.depot] && info.depots[d.depot].manifests && info.depots[d.depot].manifests[game.branch];
			if (m) latest.set(d.depot, typeof m === 'object' ? m.gid : m);
		}
		log(`${game.name}: installed build ${game.buildid}, latest build ${buildid}${game.branch !== 'public' ? ` (branch ${game.branch})` : ''}`);
	} else {
		const cache = `${STEAM}\\depotcache`;
		const files = fs.existsSync(cache) ? fs.readdirSync(cache) : [];
		for (const d of game.depots) {
			const newest = files.filter(n => n.startsWith(`${d.depot}_`))
				.map(n => [n, fs.statSync(`${cache}\\${n}`).mtimeMs]).sort((a, b) => b[1] - a[1])[0];
			if (newest) latest.set(d.depot, newest[0].slice(String(d.depot).length + 1, -9));
		}
	}
	return {latest, buildid};
}

// from Steam's depotcache when present, else from the CDN (cached in state\<app>)
async function fetchManifest(client, game, depot, id) {
	let file = `${STEAM}\\depotcache\\${depot}_${id}.manifest`;
	if (!fs.existsSync(file)) {
		file = path.join(game.state, `${depot}_${id}.manifest`);
		if (!fs.existsSync(file)) {
			if (!client) throw new Error(`Manifest ${depot}_${id} not cached locally; run apply to download it`);
			log(`Downloading manifest ${depot}_${id}...`);
			const {manifest} = await client.getRawManifest(game.app, depot, id, game.branch);
			fs.writeFileSync(file, manifest);
		}
	}
	try {
		return loadManifest(file);
	} catch (e) {
		// downloaded manifests have encrypted filenames
		const ContentManifest = require('steam-user/components/content_manifest.js');
		const m = ContentManifest.parse(fs.readFileSync(file));
		ContentManifest.decryptFilenames(m, (await client.getDepotDecryptionKey(game.app, depot)).key);
		return normalize(m);
	}
}

function normalize(m) {
	for (const f of m.files) {
		f.filename = f.filename.replace(/\//g, '\\');
		f.size = Number(f.size);
		for (const c of f.chunks) c.offset = Number(c.offset);
		f.chunks.sort((a, b) => a.offset - b.offset);
	}
	return m;
}

// one entry per depot that has a newer manifest
async function prepare(client, game) {
	fs.mkdirSync(game.state, {recursive: true});
	const {latest, buildid} = await latestManifests(client, game);
	const jobs = [];
	for (const d of game.depots) {
		const newId = latest.get(d.depot);
		if (!newId || newId === d.manifest) continue;
		const oldM = await fetchManifest(client, game, d.depot, d.manifest);
		const newM = await fetchManifest(client, game, d.depot, newId);
		const plan = buildPlan(oldM, newM);
		const sched = schedule(plan);
		const dir = path.join(game.state, String(d.depot));
		fs.mkdirSync(dir, {recursive: true});
		jobs.push({depot: d.depot, oldId: d.manifest, newId, newM, plan, sched, dir});
	}
	return {jobs, buildid};
}

function summary(job) {
	const t = job.plan.totals;
	log(`depot ${job.depot}: ${t.changedFiles} changed files, ${t.unchangedFiles} unchanged`);
	log(`depot ${job.depot}: already in place ${gib(t.keep)}, to shift within the files ${gib(t.move)}, to download ${gib(t.download)} (${gib(t.downloadCompressed)} over the network)`);
	if (job.plan.deleted.length) log(`depot ${job.depot}: files to delete:`, job.plan.deleted.join(', '));
}

const patchBytes = job => job.sched.steps.reduce((s, x) => s + (x.stash ? 0 : x.op.len), 0);
const verifyBytes = job => job.plan.files.reduce((s, f) => s + f.size, 0);

// ---------- downloading ----------

class Downloader {
	constructor(client, app, depot) {
		Object.assign(this, {client, app, depot, servers: null, next: 0});
	}
	async chunk(sha) {
		if (!this.servers) this.servers = (await this.client.getContentServers(this.app)).servers;
		let lastErr;
		for (let attempt = 0; attempt < 8; attempt++) {
			const server = this.servers[this.next++ % this.servers.length];
			const details = {app: this.app, depot: this.depot, sha, attempt: attempt + 1,
				server: server.Host, vhost: server.vhost, https: server.https_support};
			const started = Date.now();
			debug.write('chunk-start', details);
			try {
				const {chunk} = await debug.run(details, () => this.client.downloadChunk(this.app, this.depot, sha, server));
				debug.write('chunk-complete', {...details, bytes: chunk.length, elapsedMs: Date.now() - started});
				return chunk;
			} catch (e) {
				debug.error('chunk-failed', e, {...details, elapsedMs: Date.now() - started});
				if (debug.enabled) console.error(`[debug] chunk ${sha}, attempt ${attempt + 1}/8, server ${server.Host}: ${e.message}`);
				lastErr = e;
				await sleep(500 * (attempt + 1));
			}
		}
		throw new Error(`chunk ${sha} failed: ${lastErr && lastErr.message}`);
	}
}

// chunks to download, deduplicated; the same chunk can be needed at several places
const downloadList = job => [...new Map(job.sched.ops.filter(o => o.type === 'download').map(o => [o.sha, o])).values()];

// Downloads every new chunk into the stash before the game files are touched. Resumable.
async function downloadAll(dl, job) {
	const stashFile = path.join(job.dir, `stash-${job.newId}.bin`);
	const indexFile = path.join(job.dir, `stash-${job.newId}.json`);
	const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
	let end = Object.values(index).reduce((m, e) => Math.max(m, e.pos + e.len), 0);
	const fh = await fsp.open(stashFile, fs.existsSync(stashFile) ? 'r+' : 'w+');
	await fh.truncate(end);

	const all = downloadList(job);
	const todo = all.filter(o => !index[o.sha]);
	gui.add('download', all.reduce((s, o) => s + o.compressed, 0) - todo.reduce((s, o) => s + o.compressed, 0));
	const total = todo.reduce((s, o) => s + o.compressed, 0);
	log(`depot ${job.depot}: downloading ${todo.length} chunks (${gib(total)}), ${Object.keys(index).length} already in the stash`);
	const prog = progress('download', total);
	let i = 0, sinceSave = 0;
	const save = () => fs.writeFileSync(indexFile, JSON.stringify(index));
	const worker = async () => {
		while (i < todo.length) {
			const op = todo[i++];
			const data = await dl.chunk(op.sha);
			const pos = end;
			end += data.length;
			await fh.write(data, 0, data.length, pos);
			index[op.sha] = {pos, len: data.length};
			prog.add(op.compressed);
			if (++sinceSave >= 200) {
				sinceSave = 0;
				await fh.sync();
				save();
			}
		}
	};
	await Promise.all(Array.from({length: 16}, worker));
	await fh.sync();
	save();
	return {fh, index};
}

// ---------- patching ----------

async function openGameFile(game, name, handles) {
	const k = name.toLowerCase();
	if (handles.has(k)) return handles.get(k);
	const full = path.join(game.dir, name);
	await fsp.mkdir(path.dirname(full), {recursive: true});
	const fh = await fsp.open(full, fs.existsSync(full) ? 'r+' : 'w+');
	handles.set(k, fh);
	return fh;
}

async function readAt(fh, pos, len) {
	const buf = Buffer.allocUnsafe(len);
	let got = 0;
	while (got < len) {
		const {bytesRead} = await fh.read(buf, got, len - got, pos + got);
		if (!bytesRead) break;
		got += bytesRead;
	}
	return got === len ? buf : buf.subarray(0, got);
}

async function patchDepot(client, game, job) {
	const {plan, sched} = job;
	const dl = new Downloader(client, game.app, job.depot);
	const {fh: stash, index} = await downloadAll(dl, job);
	const fromStash = async sha => {
		const e = index[sha];
		const buf = e && await readAt(stash, e.pos, e.len);
		return buf && sha1(buf) === sha ? buf : dl.chunk(sha);
	};

	const handles = new Map();
	// grow files first so every destination exists
	for (const f of plan.files) {
		const fh = await openGameFile(game, f.filename, handles);
		const {size} = await fh.stat();
		if (size < f.size) await fh.truncate(f.size);
	}

	const checkpoint = path.join(job.dir, `checkpoint-${job.newId}.json`);
	const start = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')).step : 0;
	if (start) log(`depot ${job.depot}: resuming at step ${start} of ${sched.steps.length}`);
	const memStash = new Map();
	const prog = progress('patch', patchBytes(job));
	let fallbacks = 0;
	for (let n = 0; n < sched.steps.length; n++) {
		const {op, stash: toStash, fromStash: useStash} = sched.steps[n];
		if (n < start) {
			if (!toStash) prog.add(op.len);
			continue;
		}
		if (toStash) {
			const src = await openGameFile(game, op.src.file, handles);
			const buf = await readAt(src, op.src.offset, op.len);
			if (sha1(buf) === op.sha) memStash.set(op.id, buf);
			continue;
		}
		const dst = await openGameFile(game, op.file, handles);
		let data;
		if (op.type === 'download') {
			data = await fromStash(op.sha);
		} else if (useStash) {
			data = memStash.get(op.id);
			memStash.delete(op.id);
		} else {
			const src = await openGameFile(game, op.src.file, handles);
			data = await readAt(src, op.src.offset, op.len);
		}
		if (!data || sha1(data) !== op.sha) {
			// source no longer holds the expected data (old file differed, or resuming after a crash)
			const cur = await readAt(dst, op.offset, op.len);
			if (sha1(cur) === op.sha) data = null;
			else { data = await dl.chunk(op.sha); fallbacks++; }
		}
		if (data) await dst.write(data, 0, data.length, op.offset);
		prog.add(op.len);
		if (n % 2000 === 0) {
			for (const h of handles.values()) await h.sync();
			fs.writeFileSync(checkpoint, JSON.stringify({step: n}));
		}
	}
	for (const f of plan.files) {
		const fh = await openGameFile(game, f.filename, handles);
		await fh.truncate(f.size);
	}
	for (const h of handles.values()) { await h.sync(); await h.close(); }
	fs.writeFileSync(checkpoint, JSON.stringify({step: sched.steps.length}));
	for (const name of plan.deleted) {
		const full = path.join(game.dir, name);
		if (fs.existsSync(full)) fs.unlinkSync(full);
	}
	await stash.close();
	log(`depot ${job.depot}: patch written (${fallbacks} chunks re-downloaded on the fly).`);
}

async function verifyDepot(game, job, dl, quiet) {
	const prog = quiet ? {add() {}} : progress('verify', verifyBytes(job));
	const result = await verifyFiles({directory: game.dir, files: job.plan.files,
		readAt, download: sha => dl.chunk(sha), progress: prog, shouldSkip: gui.skipVerification});
	verificationLog(result.skipped ? `depot ${job.depot}: verification skipped` : result.bad
		? `depot ${job.depot}: verify repaired ${result.bad} chunks`
		: `depot ${job.depot}: verify OK, every changed file matches the new build`);
	return result;
}

// ---------- Steam app manifest ----------

function fixAcf(game, jobs, buildid) {
	const text = fs.readFileSync(game.file, 'utf8');
	fs.writeFileSync(path.join(game.state, `appmanifest_${game.app}.acf.bak`), text);
	const set = (t, k, v) => t.replace(new RegExp(`("${k}"\\s+")[^"]*(")`), `$1${v}$2`);
	let t = text;
	let total = 0;
	for (const d of game.depots) {
		const job = jobs.find(j => j.depot === d.depot);
		if (!job) { total += d.size; continue; }
		const size = job.newM.files.reduce((s, f) => s + (f.flags & 64 ? 0 : f.size), 0);
		total += size;
		t = t.replace(new RegExp(`("${d.depot}"\\s*\\{\\s*"manifest"\\s+")\\d+("\\s*"size"\\s+")\\d+`), `$1${job.newId}$2${size}`);
	}
	for (const [k, v] of Object.entries({
		StateFlags: '4', buildid, TargetBuildID: buildid, UpdateResult: '0', SizeOnDisk: String(total),
		BytesToDownload: '0', BytesDownloaded: '0', BytesToStage: '0', BytesStaged: '0',
		LastUpdated: String(Math.floor(Date.now() / 1000)),
	})) t = set(t, k, v);
	fs.writeFileSync(game.file, t);

	// park leftover staging folders of Steam's own attempt so it doesn't resume it
	const parked = path.join(game.state, 'parked-downloading');
	const dlDir = `${game.lib}\\steamapps\\downloading`;
	for (const n of fs.existsSync(dlDir) ? fs.readdirSync(dlDir) : []) {
		if (n === String(game.app) || n.startsWith(`state_${game.app}_`) || jobs.some(j => n.startsWith(`depot_${j.depot}_`))) {
			fs.mkdirSync(parked, {recursive: true});
			fs.renameSync(path.join(dlDir, n), path.join(parked, n));
		}
	}
	log(`${game.name}: Steam app manifest updated to build ${buildid}`);
}

// ---------- flows ----------

async function update(client, app) {
	const game = openGame(app);
	await closeSteam();
	const {jobs, buildid} = await prepare(client, game);
	if (!jobs.length) {
		log(`${game.name} is already up to date (build ${game.buildid}).`);
		if (buildid && buildid !== game.buildid) fixAcf(game, [], buildid);
		return;
	}
	jobs.forEach(summary);
	gui.setTotals(
		jobs.reduce((s, j) => s + downloadList(j).reduce((a, o) => a + o.compressed, 0), 0),
		jobs.reduce((s, j) => s + patchBytes(j), 0),
		jobs.reduce((s, j) => s + verifyBytes(j), 0),
	);
	for (const job of jobs) await patchDepot(client, game, job);
	log('Download and patching complete.');
	gui.setVerification({active: true});
	try {
		for (const job of jobs) {
			if (gui.skipVerification()) break;
			const dl = new Downloader(client, game.app, job.depot);
			const result = await verifyDepot(game, job, dl);
			if (result.skipped) break;
			if (result.bad) {
				const again = await verifyDepot(game, job, dl, true);
				if (again.skipped) break;
				if (again.bad) throw new Error(`depot ${job.depot}: ${again.bad} chunks still wrong after repair`);
			}
		}
	} finally {
		gui.setVerification({active: false});
	}
	gui.setVerification({message: gui.skipVerification() ? 'Verification skipped' : 'Verification complete'});
	fixAcf(game, jobs, buildid);
	for (const job of jobs) fs.rmSync(job.dir, {recursive: true, force: true});
	log(`Done: ${game.name} is on build ${buildid}.${gui.skipVerification() ? ' Verification skipped.' : ''} Start Steam; optionally run Properties > Installed Files > Verify integrity once.`);
}

(async () => {
	const [cmd = 'gui', arg] = debug.argv;
	fs.mkdirSync(STATE, {recursive: true});

	if (cmd === 'gui') {
		// double-clicked exe: choose a game in the browser page
		gui.start();
		try {
			gui.set({games: listGames(), message: 'Choose a game to update'});
			const app = await gui.waitForChoice();
			const game = openGame(app);
			gui.set({title: `Updating ${game.name}`});
			const client = await login();
			await update(client, app);
			client.logOff();
			gui.set({finished: true});
		} catch (e) {
			debug.error('fatal', e);
			console.error('\nERROR:', e.message);
			gui.set({error: e.message});
		}
		console.log('\nPress Enter to close.');
		process.stdin.once('data', () => process.exit(0));
		return;
	}
	if (cmd === 'list') {
		for (const g of listGames()) console.log(String(g.app).padEnd(9), `${g.gb} GB`.padStart(9), g.updatePending ? ' update pending ' : '                ', g.name);
		return process.exit(0);
	}
	if (!['plan', 'apply', 'verify'].includes(cmd) || !/^\d+$/.test(arg || '')) {
		console.log('usage: node patcher.js [gui] | list | plan <appid> | apply <appid> | verify <appid> [-debug]');
		return process.exit(1);
	}
	const app = Number(arg);
	if (cmd === 'plan') {
		const game = openGame(app);
		const {jobs} = await prepare(null, game);
		if (!jobs.length) log(`${game.name}: no newer manifest in Steam's depotcache`);
		jobs.forEach(summary);
		return process.exit(0);
	}
	const client = await login();
	if (cmd === 'apply') await update(client, app);
	if (cmd === 'verify') {
		const game = openGame(app);
		const {jobs} = await prepare(client, game);
		for (const job of jobs) await verifyDepot(game, job, new Downloader(client, app, job.depot));
	}
	client.logOff();
	setTimeout(() => process.exit(0), 1000);
})().catch(e => {
	debug.error('fatal', e);
	console.error('\nERROR:', e.message);
	process.exit(1);
});
