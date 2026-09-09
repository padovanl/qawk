import { signOut } from './auth.js';
import { toast } from './chrome.js';
import { $, h } from './dom.js';
import { render } from './router.js';

/* --------------------------------------------------------------- the API */
const S = {
  auth: sessionStorage.getItem('hb-auth') || '',
  user: sessionStorage.getItem('hb-user') || '',
  view: 'dash', timer: null, busy: 0, counts: {}, sel: null,
  q: '', status: '',        // targets: free text / updateStatus chip
  picked: new Set(),        // controllerIds ticked for a bulk action
  dsCache: null,
};

function busy(d) {
  S.busy += d;
  $('#busy').replaceChildren(S.busy > 0 ? h('span.spin') : '');
}

async function api(path, opts = {}) {
  const o = Object.assign({ headers: {} }, opts);
  o.headers = Object.assign({ Authorization: 'Basic ' + S.auth }, o.headers);
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json);
    o.headers['Content-Type'] = 'application/json;charset=UTF-8';
    delete o.json;
  }
  busy(1);
  let r;
  try { r = await fetch('/rest/v1' + path, o); }
  catch (e) {
    busy(-1); noteConnection(false);
    throw new Error('the console cannot reach its own server: ' + e.message);
  }
  busy(-1);
  // 502 is the proxy saying hawkBit is not there; anything it answers at all
  // means the server is back.
  noteConnection(r.status !== 502);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!r.ok) {
    if (r.status === 401) { signOut(); throw new Error('not authorised'); }
    const err = new Error((data && (data.message || data.errorCode)) || ('HTTP ' + r.status));
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}
const get = p => api(p);
const post = (p, json) => api(p, { method: 'POST', json });
const put = (p, json) => api(p, { method: 'PUT', json });
const del = p => api(p, { method: 'DELETE' });
const fiql = s => encodeURIComponent(s);
const enc = encodeURIComponent;

async function upload(smId, file, onProgress) {
  // XHR, not fetch: a .swu is hundreds of megabytes and upload.onprogress is
  // the only way to show how far it has got. fetch has no equivalent.
  return new Promise((res, rej) => {
    const fd = new FormData(); fd.append('file', file);
    const x = new XMLHttpRequest();
    x.open('POST', `/rest/v1/softwaremodules/${smId}/artifacts`);
    x.setRequestHeader('Authorization', 'Basic ' + S.auth);
    x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return res(JSON.parse(x.responseText || '{}'));
      let m = 'HTTP ' + x.status;
      try { m = JSON.parse(x.responseText).message || m; } catch (_) {}
      rej(new Error(m));
    };
    x.onerror = () => rej(new Error('upload failed'));
    x.send(fd);
  });
}

async function distributionSets(force) {
  if (!S.dsCache || force) S.dsCache = await get('/distributionsets?limit=200&sort=id:DESC');
  return S.dsCache;
}

// Attributes are one request per target, so they are fetched once per render
// and shared by every attribute column.
/* AT TWO HUNDRED ROWS the per-row lookups are hundreds of requests, and a
 * browser will happily open all of them at once: the page stalls, and hawkBit
 * sees a burst that looks like an attack. Six at a time keeps the table filling
 * visibly from the top without ever queueing the whole page. */
let inFlight = 0;
const waiting = [];
function limited(fn) {
  return new Promise((res, rej) => {
    const run = () => {
      inFlight++;
      fn().then(res, rej).finally(() => {
        inFlight--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (inFlight < 6) run(); else waiting.push(run);
  });
}

function noteConnection(ok) {
  if (ok && S.offline) { S.offline = false; toast('Reconnected', 'hawkBit is answering again', 'ok'); }
  else if (!ok && !S.offline) {
    S.offline = true;
    toast('Lost the server', 'hawkBit is not answering — the tables are the last good copy', 'err', 20000);
  }
}

export {
  S, busy, del, distributionSets, enc, fiql, get, limited, post, put, upload, waiting,
};
