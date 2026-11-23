// INPUT HARDENING — regression pins for parsing and sanitisation helpers:
// linear-time matching, order-safe entity decoding, repeated tag stripping,
// non-guessable ids, and an allow-list on the panel's open-link target.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinateQuery } from '../search/coordinateParser.js';
import { endpointBase } from '../layers/streetLevel/providers/mapillary/source.js';
import { createDebugSessionId } from '../voice/realtimeDiagnostics.js';
import { decodeRssText } from '../../server/providers/regional/news.js';
import { decodeNumericEntities } from '../../server/providers/cctv/normalize.js';
import { driveBcImageCredit } from '../../server/providers/cctv/sources.js';
import { buildSyntheticCctvSvg } from '../../server/providers/cctv/media.js';
import { aisKeyFingerprint } from '../../server/providers/vessels/ais-live.js';
import { escapeFsDenyPath } from '../../build/vite.js';
import { panelRuntime } from '../app/globePanelRuntime.js';

test('coordinate parsing stays linear on long whitespace runs', () => {
  const started = performance.now();
  assert.equal(parseCoordinateQuery(`12${' '.repeat(50000)}x, 34`), null);
  assert.ok(performance.now() - started < 1000);
  assert.equal(parseCoordinateQuery('43.5 ° N, 79.3° W')?.lat, 43.5);
});

test('mapillary endpoint base keeps exactly one trailing slash', () => {
  assert.equal(endpointBase('https://x.test/api'), 'https://x.test/api/');
  assert.equal(endpointBase('https://x.test/api///'), 'https://x.test/api/');
  assert.equal(endpointBase('   '), '');
  assert.equal(endpointBase(undefined), '');
  const started = performance.now();
  endpointBase(`a${'/'.repeat(100000)}b`);
  assert.ok(performance.now() - started < 1000);
});

test('debug session ids are well formed and differ between calls', () => {
  const a = createDebugSessionId();
  assert.match(a, /^gev-[0-9a-z]+-[0-9a-f]{12}$/);
  assert.notEqual(a, createDebugSessionId());
});

test('entity decoding does not unescape twice', () => {
  assert.equal(decodeRssText('Fish &amp;lt;b&amp;gt; &amp; chips'), 'Fish &lt;b&gt; & chips');
  assert.equal(decodeRssText('a &lt;b&gt; c &amp;amp; d'), 'a c &amp; d');
  assert.equal(decodeNumericEntities('&amp;quot; &amp;lt; &quot;'), '&quot; &lt; "');
  assert.equal(decodeNumericEntities('&#65;&amp;#66;'), 'A&#66;');
});

test('image credit strips nested markup completely', () => {
  assert.equal(driveBcImageCredit('<<b>b>Courtesy of X</b>'), 'bCourtesy of X');
  assert.equal(driveBcImageCredit('<scr<script>ipt>Courtesy of Y'), 'iptCourtesy of Y');
  assert.equal(driveBcImageCredit('<b>Courtesy of Z</b>'), 'Courtesy of Z');
  assert.equal(driveBcImageCredit('relies on solar power'), '');
});

test('synthetic cctv svg escapes labels and stamps a timestamp', () => {
  const svg = buildSyntheticCctvSvg({ cameraId: 'a<b', label: '"x" & y', city: 'C', status: 's' });
  assert.ok(!svg.includes('a<b'));
  assert.match(svg, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test('ais key fingerprint is stable per key and never the key', () => {
  const saved = process.env.AISSTREAM_API_KEY;
  try {
    delete process.env.AISSTREAM_API_KEY;
    assert.equal(aisKeyFingerprint(), null);
    process.env.AISSTREAM_API_KEY = 'secret-one';
    const one = aisKeyFingerprint();
    assert.match(one, /^key-\d+$/);
    assert.ok(!one.includes('secret'));
    assert.equal(aisKeyFingerprint(), one);
    process.env.AISSTREAM_API_KEY = 'secret-two';
    assert.notEqual(aisKeyFingerprint(), one);
  } finally {
    if (saved === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = saved;
  }
});

test('fs deny paths escape backslashes and glob characters', () => {
  const BS = String.fromCharCode(92);
  assert.equal(
    escapeFsDenyPath(`a${BS}b(c)*`),
    `a${BS}${BS}b${BS}(c${BS})${BS}*`,
  );
});

function runPanel(url) {
  const handlers = {};
  const el = () => ({
    hidden: true,
    isConnected: true,
    textContent: '',
    addEventListener: (type, fn) => (handlers[`el:${type}`] = fn),
  });
  const saved = {};
  const set = (k, v) => {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  };
  const opened = [];
  const posted = [];
  const nodes = { status: el(), open: el(), expand: el() };
  set('document', {
    baseURI: 'https://host.test/',
    getElementById: (id) => nodes[id] || el(),
    addEventListener() {},
  });
  set('window', {
    parent: { postMessage: (m) => posted.push(m) },
    postMessage() {},
    addEventListener: (type, fn) => (handlers[type] = fn),
    open: (...args) => opened.push(args),
  });
  set('history', { replaceState() {} });
  set('location', { href: 'https://host.test/' });
  try {
    panelRuntime({ toolName: 't', panelKey: 'k', appBaseUrl: 'https://app.test', loadTimeoutMs: 1 });
    handlers.message?.({
      source: globalThis.window.parent,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { structuredContent: { view: { x: 1 }, url } },
      },
    });
  } catch (error) {
    if (process.env.DEBUG_PANEL) console.error(error.stack);
  }
  const shown = nodes.open.hidden === false;
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else delete globalThis[k];
  }
  return shown;
}

test('panel only offers http(s) addresses as the open target', () => {
  assert.equal(runPanel('https://app.test/#view=1'), true);
  assert.equal(runPanel('javascript:alert(1)'), false);
  assert.equal(runPanel('data:text/html,x'), false);
  assert.equal(runPanel('/relative'), false);
});
