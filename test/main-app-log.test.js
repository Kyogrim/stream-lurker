// Gate tests for main/app-log.js. G2.1: the process-wide error sink records
// and never throws, is rate-limited, and keeps a capped file. F71: console
// lines read Electron 35+'s event fields. The last test runs real Node
// processes to prove a throw from a timer and a rejected fire-and-forget
// promise both reach the sink and the process keeps running. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createFatalReporter, describeError, formatConsoleMessage } = require('../main/app-log');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-app-log-')), 'logs', 'main-errors.log');
}

test('records to the log, the console and the file', () => {
  const file = tempFile();
  const logged = [];
  const consoled = [];
  const report = createFatalReporter({ log: (t) => logged.push(t), consoleError: (t) => consoled.push(t), filePath: () => file, now: () => 0 });
  report('uncaughtException', new TypeError('boom'));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[Main error\] uncaughtException: TypeError: boom/);
  assert.ok(logged[0].split('\n').length <= 4, 'the activity log gets a short stack');
  assert.match(consoled[0], /TypeError: boom/);
  assert.match(fs.readFileSync(file, 'utf8'), /1970-01-01T00:00:00\.000Z \[Main error\] uncaughtException: TypeError: boom/);
});

test('never throws: a throwing log, console and unwritable file are all survived', () => {
  const report = createFatalReporter({
    log: () => { throw new Error('webContents destroyed'); },
    consoleError: () => { throw new Error('EPIPE'); },
    filePath: () => { throw new Error('no userData'); },
  });
  assert.doesNotThrow(() => report('uncaughtException', new Error('x')));
  const hostile = { get stack() { throw new Error('getter'); }, toString() { throw new Error('toString'); } };
  assert.doesNotThrow(() => report('unhandledRejection', hostile));
  assert.equal(describeError(hostile), '[an error that could not be printed]');
  assert.equal(describeError('plain string'), 'plain string');
  assert.equal(describeError(undefined), 'undefined');
});

test('a recurring error is logged once per window, with a repeat count next time', () => {
  let t = 0;
  const logged = [];
  const report = createFatalReporter({ log: (x) => logged.push(x), consoleError: () => {}, now: () => t, windowMs: 60000 });
  for (let i = 0; i < 1000; i++) { t = i; report('uncaughtException', new Error('same every tick')); }
  assert.equal(logged.length, 1);
  t = 61000;
  report('uncaughtException', new Error('same every tick'));
  assert.equal(logged.length, 2);
  assert.match(logged[1], /also happened 999 more times/);
});

test('a burst of distinct errors is capped per window and summarised', () => {
  let t = 0;
  const logged = [];
  const report = createFatalReporter({ log: (x) => logged.push(x), consoleError: () => {}, now: () => t, maxPerWindow: 5 });
  for (let i = 0; i < 50; i++) report('uncaughtException', new Error(`distinct ${i}`));
  assert.equal(logged.length, 5);
  t = 60000;
  report('uncaughtException', new Error('after the burst'));
  assert.match(logged[5], /45 other errors were not logged/);
});

test('the file rotates at the cap instead of growing forever', () => {
  const file = tempFile();
  let t = 0;
  const report = createFatalReporter({ consoleError: () => {}, filePath: file, now: () => t, maxBytes: 400, maxPerWindow: 1000, windowMs: 1 });
  for (let i = 0; i < 40; i++) { t += 10; report('uncaughtException', { stack: `Error: line ${i}` }); }
  assert.ok(fs.statSync(file).size <= 400);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(`${file}.1`).size <= 400);
  assert.match(fs.readFileSync(file, 'utf8'), /Error: line 39\n$/, 'the newest entry is in the live file');
});

test('one huge error is truncated in the file', () => {
  const file = tempFile();
  const report = createFatalReporter({ consoleError: () => {}, filePath: file });
  report('unhandledRejection', new Error('x'.repeat(100000)));
  const size = fs.statSync(file).size;
  assert.ok(size < 17 * 1024, `${size} bytes`);
  assert.match(fs.readFileSync(file, 'utf8'), /\[truncated\]\n$/);
});

test('F71: console lines come from the event fields (Electron 35+)', () => {
  const line = formatConsoleMessage('MainWindow', { level: 'error', message: 'Uncaught TypeError: x is undefined', lineNumber: 42, sourceId: 'app://bundle/renderer.js' });
  assert.equal(line, '[Console - MainWindow] [error] Uncaught TypeError: x is undefined at app://bundle/renderer.js:42');
  assert.doesNotThrow(() => formatConsoleMessage('TwitchPageWin', undefined));
});

// The real Node semantics the handler relies on, in a child process: a throw
// from a timer arrives as 'uncaughtException', a rejected fire-and-forget
// async call as 'unhandledRejection', and with listeners installed the
// process keeps running (the timer after them still fires).
test('G2.1: timer throws and stray rejections reach the sink and the process survives', () => {
  const script = `
    const { createFatalReporter } = require(${JSON.stringify(path.join(__dirname, '..', 'main', 'app-log.js'))});
    const seen = [];
    const report = createFatalReporter({ log: (t) => seen.push(t.split('\\n')[0]), consoleError: () => {} });
    process.on('uncaughtException', (err, origin) => report(origin, err));
    process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));
    setTimeout(() => { throw new Error('thrown from a timer'); }, 1);
    setTimeout(async () => { throw new Error('rejected in an async timer'); }, 2);
    setTimeout(() => { Promise.reject(new Error('fire and forget')); }, 3);
    setTimeout(() => { console.log(JSON.stringify(seen)); }, 50);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout.trim());
  assert.deepEqual(seen, [
    '[Main error] uncaughtException: Error: thrown from a timer',
    '[Main error] unhandledRejection: Error: rejected in an async timer',
    '[Main error] unhandledRejection: Error: fire and forget',
  ]);
});
