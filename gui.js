// Tiny progress page on localhost, opened in the default browser. Only enabled for the double-click flow.
const http = require('http');
const {exec} = require('child_process');

const state = {
	title: 'ARK: Survival Ascended updater',
	message: 'Starting...',
	qr: null,
	dl: {done: 0, total: 0},
	inst: {done: 0, total: 0},
	finished: false,
	error: null,
};
const parts = {patch: 0, verify: 0};
// seconds-per-byte relative to patching, measured on an NVMe SSD: download ~35 MB/s, patch ~340 MB/s, verify ~550 MB/s
const WEIGHT = {download: 10, patch: 1, verify: 0.6};
const totals = {patch: 0, verify: 0};
let enabled = false;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ASA updater</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#6b7280;--track:#e5e7eb;--dl:#2f80ed;--inst:#27ae60;--err:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaee;--muted:#9aa1ad;--track:#2c313b;--dl:#4c9bff;--inst:#3ccf7a;--err:#ff6b5b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:var(--card);border-radius:14px;padding:28px 32px;width:min(560px,calc(100vw - 32px));box-sizing:border-box;box-shadow:0 4px 24px #0002}
h1{font-size:19px;margin:0 0 4px}.msg{color:var(--muted);min-height:1.5em;margin-bottom:18px;word-break:break-word}
.bar{display:flex;height:22px;border-radius:11px;background:var(--track);overflow:hidden;position:relative}
.seg{height:100%;transition:width .4s}.dl{background:var(--dl)}.inst{background:var(--inst)}
.legend{display:flex;justify-content:space-between;margin-top:10px;font-size:13px;color:var(--muted);gap:12px;flex-wrap:wrap}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.pct{font-size:28px;font-weight:600;margin:6px 0 12px;font-variant-numeric:tabular-nums}
#qr{text-align:center;margin:8px 0 18px}#qr img{width:220px;height:220px;image-rendering:pixelated;background:#fff;padding:8px;border-radius:8px}
.err{color:var(--err);font-weight:600}
</style></head><body><div class="card">
<h1 id="title"></h1><div class="msg" id="msg"></div>
<div id="qr"></div>
<div class="pct" id="pct">0%</div>
<div class="bar"><div class="seg dl" id="bdl"></div><div class="seg inst" id="binst"></div></div>
<div class="legend"><span><span class="dot" style="background:var(--dl)"></span>Download <b id="ldl"></b></span>
<span><span class="dot" style="background:var(--inst)"></span>Installing <b id="linst"></b></span></div>
</div><script>
const g=n=>(n/2**30).toFixed(2)+' GB';
async function tick(){
 try{const s=await (await fetch('/status')).json();
  document.getElementById('title').textContent=s.title;
  const m=document.getElementById('msg');m.textContent=s.error?('Error: '+s.error):s.message;m.className='msg'+(s.error?' err':'');
  document.getElementById('qr').innerHTML=s.qr?'<div>Scan with the Steam app (Steam Guard &gt; scan QR code)</div><img src="'+s.qr+'">':'';
  const T=(s.dl.wTotal||0)+(s.inst.wTotal||0)||1;
  document.getElementById('bdl').style.width=(100*(s.dl.wDone||0)/T)+'%';
  document.getElementById('binst').style.width=(100*(s.inst.wDone||0)/T)+'%';
  document.getElementById('pct').textContent=s.finished?'Done':(100*((s.dl.wDone||0)+(s.inst.wDone||0))/T).toFixed(1)+'%';
  document.getElementById('ldl').textContent=g(s.dl.done)+' / '+g(s.dl.total);
  document.getElementById('linst').textContent=g(s.inst.done)+' / '+g(s.inst.total);
  if(s.finished||s.error)return;
 }catch(e){document.getElementById('msg').textContent='Updater closed.';return}
 setTimeout(tick,700)}
tick();
</script></body></html>`;

function start() {
	enabled = true;
	const server = http.createServer((req, res) => {
		if (req.url === '/status') {
			res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
			return res.end(JSON.stringify(state));
		}
		res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
		res.end(PAGE);
	});
	server.listen(0, '127.0.0.1', () => {
		const url = `http://127.0.0.1:${server.address().port}/`;
		console.log('Progress page:', url);
		exec(`start "" "${url}"`);
	});
	server.unref();
}

function set(obj) {
	if (enabled) Object.assign(state, obj);
	weigh();
}

function setInstallTotals(patch, verify) {
	totals.patch = patch;
	totals.verify = verify;
	set({inst: {done: 0, total: patch + verify}});
}

function weigh() {
	state.dl.wDone = state.dl.done * WEIGHT.download;
	state.dl.wTotal = state.dl.total * WEIGHT.download;
	state.inst.wDone = parts.patch * WEIGHT.patch + parts.verify * WEIGHT.verify;
	state.inst.wTotal = totals.patch * WEIGHT.patch + totals.verify * WEIGHT.verify;
}

// download feeds the first segment; patch + verify together form "installing"
function progress(label, done) {
	if (!enabled) return;
	if (label === 'download') state.dl.done = done;
	else {
		parts[label] = done;
		state.inst.done = Math.min(state.inst.total, parts.patch + parts.verify);
	}
	weigh();
}

async function showQr(url) {
	if (!enabled) return;
	state.qr = url ? await require('qrcode').toDataURL(url, {margin: 1, scale: 6}) : null;
}

module.exports = {start, set, setInstallTotals, progress, showQr};
