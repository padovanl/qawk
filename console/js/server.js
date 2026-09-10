import { get } from './api.js';
import { $ } from './dom.js';

/* Which server is the console talking to?
 *
 * The console talks to Qawk, our own server, and it can still talk to a stock
 * hawkBit. Which one is on the other end changes what a page means -- Qawk
 * has pages hawkBit does not -- so it is written where the name of the product
 * used to be, top left, always in view, and on the About page.
 *
 * Qawk says what it is at /qawk/v1/info. hawkBit has no such thing: a 404
 * there means hawkBit, which publishes no version over HTTP at all.
 */
let INFO = null;

async function whoIsServer() {
  try {
    const i = await get('/qawk/v1/info', { abs: true });
    INFO = { name: i.name || 'Qawk', version: i.version || '', qawk: true, features: i.features || [] };
  } catch (_) {
    INFO = { name: 'hawkBit', version: '', qawk: false, features: [] };
  }
  const n = $('#srv-name'), v = $('#srv-ver'), b = $('.brand');
  if (n) n.textContent = INFO.name;
  if (v) v.textContent = INFO.version ? `console · ${INFO.version}` : 'console';
  if (b) b.title = `talking to ${INFO.name}${INFO.version ? ' ' + INFO.version : ''} at ${location.host}`;
  const c = $('#conn');
  if (c && c.textContent.endsWith('@ hawkBit')) c.textContent = c.textContent.replace(/@ hawkBit$/, '@ ' + INFO.name);
  return INFO;
}

const serverInfo = () => INFO;

export { serverInfo, whoIsServer };
