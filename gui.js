// Tiny progress page on localhost, opened in the default browser. Only enabled for the double-click flow.
const http = require('http');
const {exec} = require('child_process');

const state = {
	title: 'Steam in-place patcher',
	message: 'Starting...',
	games: null,
	chosen: false,
	qr: null,
	dl: {done: 0, total: 0},
	inst: {done: 0, total: 0},
	verify: {done: 0, total: 0, active: false, skipped: false, message: ''},
	finished: false,
	error: null,
};
// Relative time per byte for downloading and patching; verification is separate.
const WEIGHT = {download: 10, patch: 1};
const done = {download: 0, patch: 0, verify: 0};
const totals = {download: 0, patch: 0, verify: 0};
let enabled = false;
let choose = null;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Steam in-place patcher</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#6b7280;--track:#e5e7eb;--line:#d5d9e0;--dl:#2f80ed;--inst:#27ae60;--err:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaee;--muted:#9aa1ad;--track:#2c313b;--line:#3a404c;--dl:#4c9bff;--inst:#3ccf7a;--err:#ff6b5b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:var(--card);border-radius:14px;padding:28px 32px;width:min(580px,calc(100vw - 32px));box-sizing:border-box;box-shadow:0 4px 24px #0002}
h1{font-size:19px;margin:0 0 4px}.msg{color:var(--muted);min-height:1.5em;margin-bottom:18px;word-break:break-word}
.pick{display:flex;gap:10px;margin-bottom:6px}
select{flex:1;min-width:0;font:inherit;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
button{font:inherit;font-weight:600;padding:9px 18px;border:0;border-radius:8px;background:var(--dl);color:#fff;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.hint{font-size:13px;color:var(--muted)}
.verification{margin-top:16px;font-size:12px;color:var(--muted)}
.verification button{font-size:12px;padding:4px 8px;margin-left:8px;background:transparent;color:var(--muted);border:1px solid var(--line)}
.support{margin-top:20px;font-size:12px;color:var(--muted)}.support a{color:inherit}
.bar{display:flex;height:22px;border-radius:11px;background:var(--track);overflow:hidden}
.seg{height:100%;transition:width .4s}.dl{background:var(--dl)}.inst{background:var(--inst)}
.legend{display:flex;justify-content:space-between;margin-top:10px;font-size:13px;color:var(--muted);gap:12px;flex-wrap:wrap}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.pct{font-size:28px;font-weight:600;margin:6px 0 12px;font-variant-numeric:tabular-nums}
#qr{text-align:center;margin:8px 0 18px}#qr img{width:220px;height:220px;image-rendering:pixelated;background:#fff;padding:8px;border-radius:8px}
.err{color:var(--err);font-weight:600}.hide{display:none}
</style></head><body><div class="card">
<h1 id="title"></h1><div class="msg" id="msg"></div>
<div id="picker" class="hide">
 <div class="pick"><select id="game"></select><button id="go">Update</button></div>
 <div class="hint">Steam will be closed automatically. Games marked ⬆ have an update waiting in Steam.</div>
</div>
<div id="qr"></div>
<div id="progress" class="hide">
 <div class="pct" id="pct">0%</div>
 <div class="bar"><div class="seg dl" id="bdl"></div><div class="seg inst" id="binst"></div></div>
 <div class="legend"><span><span class="dot" style="background:var(--dl)"></span>Download <b id="ldl"></b></span>
 <span><span class="dot" style="background:var(--inst)"></span>Patching <b id="linst"></b></span></div>
 <div id="verification" class="verification hide"><span id="verifytext"></span><button id="skipverify">Skip verification</button></div>
</div>
<div class="support">Saved you some disk space? <a href="https://buymeacoffee.com/swintec" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a></div>
</div><script>
const $=id=>document.getElementById(id);
const g=n=>(n/2**30).toFixed(2)+' GB';
let filled=false;
$('go').onclick=async()=>{$('go').disabled=true;await fetch('/start',{method:'POST',body:$('game').value})};
$('skipverify').onclick=async()=>{const b=$('skipverify');b.disabled=true;try{const r=await fetch('/skip-verification',{method:'POST'});if(!r.ok)b.disabled=false}catch(e){b.disabled=false}};
async function tick(){
 try{const s=await (await fetch('/status')).json();
  $('title').textContent=s.title;
  $('msg').textContent=s.error?('Error: '+s.error):s.message;$('msg').className='msg'+(s.error?' err':'');
  if(s.games&&!filled){filled=true;
   $('game').innerHTML=s.games.map(x=>'<option value="'+x.app+'">'+(x.updatePending?'⬆ ':'')+x.name.replace(/</g,'&lt;')+'  ('+x.app+', '+x.gb+' GB)</option>').join('')}
  $('picker').classList.toggle('hide',!s.games||s.chosen);
  $('qr').innerHTML=s.qr?'<div>Scan with the Steam app (Steam Guard &gt; scan QR code)</div><img src="'+s.qr+'">':'';
  $('progress').classList.toggle('hide',!(s.dl.total||s.inst.total));
  const T=(s.dl.wTotal||0)+(s.inst.wTotal||0)||1;
  $('bdl').style.width=(100*(s.dl.wDone||0)/T)+'%';
  $('binst').style.width=(100*(s.inst.wDone||0)/T)+'%';
  $('pct').textContent=s.finished?'Done':(100*((s.dl.wDone||0)+(s.inst.wDone||0))/T).toFixed(1)+'%';
  $('ldl').textContent=g(s.dl.done)+' / '+g(s.dl.total);
  $('linst').textContent=g(s.inst.done)+' / '+g(s.inst.total);
  const v=s.verify;
  $('verification').classList.toggle('hide',!v.total);
  $('verifytext').textContent=v.skipped?'Verification skipped':v.active?('Verifying: '+g(v.done)+' / '+g(v.total)+(v.message?' — '+v.message:'')):v.message||'Verification runs after patching (optional).';
  $('skipverify').classList.toggle('hide',v.skipped||s.finished||!!s.error);
  if(s.finished||s.error)return;
 }catch(e){$('msg').textContent='Updater closed.';return}
 setTimeout(tick,700)}
tick();
</script></body></html>`;

function start({openBrowser = true} = {}) {
	enabled = true;
	const server = http.createServer((req, res) => {
		if (req.url === '/status') {
			res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
			return res.end(JSON.stringify(state));
		}
		if (req.url === '/start' && req.method === 'POST') {
			let body = '';
			req.on('data', d => { body += d; });
			req.on('end', () => {
				const app = Number(body);
				if (choose && state.games && state.games.some(x => x.app === app)) {
					state.chosen = true;
					choose(app);
					choose = null;
				}
				res.end('ok');
			});
			return;
		}
		if (req.url === '/skip-verification' && req.method === 'POST') {
			if (!state.verify.total || state.finished || state.error) {
				res.writeHead(409);
				return res.end('Verification unavailable');
			}
			state.verify.skipped = true;
			return res.end('ok');
		}
		res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
		res.end(PAGE);
	});
	server.listen(0, '127.0.0.1', () => {
		const url = `http://127.0.0.1:${server.address().port}/`;
		console.log('Progress page:', url);
		if (openBrowser) exec(`start "" "${url}"`);
	});
	// keeps the process alive while waiting for a choice; the caller exits explicitly
	return server;
}

function waitForChoice() {
	return new Promise(resolve => { choose = resolve; });
}

function weigh() {
	state.dl = {done: done.download, total: totals.download, wDone: done.download * WEIGHT.download, wTotal: totals.download * WEIGHT.download};
	state.inst = {
		done: Math.min(done.patch, totals.patch), total: totals.patch,
		wDone: Math.min(done.patch, totals.patch) * WEIGHT.patch,
		wTotal: totals.patch * WEIGHT.patch,
	};
	Object.assign(state.verify, {done: Math.min(done.verify, totals.verify), total: totals.verify});
}

function set(obj) {
	if (enabled) Object.assign(state, obj);
}

function setTotals(download, patch, verify) {
	Object.assign(totals, {download, patch, verify});
	weigh();
}

// Verification bytes never affect the main bar.
function add(label, n) {
	if (!enabled || !(label in done)) return;
	done[label] += n;
	weigh();
}

async function showQr(url) {
	if (!enabled) return;
	state.qr = url ? await require('qrcode').toDataURL(url, {margin: 1, scale: 6}) : null;
}

function setVerification(obj) {
	if (enabled) Object.assign(state.verify, obj);
}

function skipVerification() {
	return enabled && state.verify.skipped;
}

module.exports = {start, set, setTotals, add, showQr, waitForChoice, setVerification, skipVerification};
