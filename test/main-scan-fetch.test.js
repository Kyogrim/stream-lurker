// Gate tests for main/scan-fetch.js against a real local server that stalls:
// once before the headers, once mid-body. Node's fetch stands in for
// Electron's net.fetch; both take the same RequestInit signal. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchTextWithDeadline, parseJsonBody } = require('../main/scan-fetch');

function startServer(handler) {
  return new Promise((resolve) => {
    const closed = [];
    const server = http.createServer((req, res) => {
      req.socket.on('close', () => closed.push(req.url));
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: path => `http://127.0.0.1:${port}${path}`,
        closed,
        stop: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  return cond();
};

test('F26: a server that never answers is cut off at the deadline and the socket is freed', async () => {
  const srv = await startServer(() => { /* never respond */ });
  try {
    const started = Date.now();
    await assert.rejects(fetchTextWithDeadline(fetch, srv.url('/hang'), {}, 300), /timed out after 300ms/);
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 2000, `took ${took} ms`);
    assert.ok(await until(() => srv.closed.includes('/hang')), 'the abort closed the connection');
  } finally {
    await srv.stop();
  }
});

test('F26: a body that stalls after the headers is cut off by the same deadline', async () => {
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<html>partial');
  });
  try {
    const started = Date.now();
    const err = await fetchTextWithDeadline(fetch, srv.url('/stall-body'), {}, 300).then(() => null, e => e);
    assert.ok(err, 'rejected');
    assert.equal(err.code, 'ETIMEDOUT');
    assert.ok(Date.now() - started < 2000);
    assert.ok(await until(() => srv.closed.includes('/stall-body')), 'the abort closed the connection');
  } finally {
    await srv.stop();
  }
});

test('F26: settles on time even if the fetch implementation ignores the signal', async () => {
  const neverSettles = () => new Promise(() => {});
  await assert.rejects(fetchTextWithDeadline(neverSettles, 'https://example.invalid/', {}, 100), /timed out/);
  const headersThenNothing = async () => ({ status: 200, ok: true, text: () => new Promise(() => {}) });
  await assert.rejects(fetchTextWithDeadline(headersThenNothing, 'https://example.invalid/', {}, 100), /timed out/);
});

test('normal and error responses resolve with status and body', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); res.end('{"a":1}'); return; }
    res.writeHead(404); res.end('missing');
  });
  try {
    const ok = await fetchTextWithDeadline(fetch, srv.url('/ok'), { headers: { 'X-Test': '1' } }, 2000);
    assert.deepEqual(ok, { status: 200, ok: true, text: '{"a":1}' });
    assert.deepEqual(parseJsonBody(ok.text, 'test'), { a: 1 });
    const missing = await fetchTextWithDeadline(fetch, srv.url('/nope'), {}, 2000);
    assert.deepEqual(missing, { status: 404, ok: false, text: 'missing' });
  } finally {
    await srv.stop();
  }
  assert.throws(() => parseJsonBody('<html>', 'Kick'), /Kick returned a response that is not JSON/);
});

test('a network error rejects with that error, not a timeout', async () => {
  const refused = async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); };
  await assert.rejects(fetchTextWithDeadline(refused, 'https://example.invalid/', {}, 5000), /ERR_CONNECTION_REFUSED/);
});
