import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'smoke-test.sh');
const url = 'https://berthday.example.workers.dev';
const version = 'abc1234';
const seeded = ['north-pier-west', 'north-pier-face', 'north-pier-east', 'inner-channel', 'south-float-west', 'south-float-east', 'small-craft-slips', 'north-finger-piers', 'unassigned'];
const resource = id => ({ id, name: id, isExclusive: false, lengthFt: null, sortOrder: 1 });
const meta = () => ({ dataRange: { from: '1997-08-01', to: '2031-12-31' }, berths: seeded.map(resource) });
const page = '<!doctype html><html><body><div id="root"></div></body></html>';

function smoke(overrides = {}, target = url, expected = version) {
  const directory = mkdtempSync(join(tmpdir(), 'berthday-smoke-test-'));
  const log = join(directory, 'requests.jsonl');
  try {
    const responses = {
      '/api/health': { body: { ok: true, version } },
      '/api/meta': { body: meta() },
      '/api/import/jobs?limit=1': { body: { items: [], nextCursor: null } },
      '/': { body: page },
      '/issues': { body: page },
      '/resources': { body: page },
      '/import': { body: page },
      '/api/does-not-exist': { body: { error: { code: 'NOT_FOUND' } }, status: 404 },
      ...overrides,
    };
    writeFileSync(join(directory, 'responses.json'), JSON.stringify(responses));
    writeFileSync(join(directory, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.some(arg => ['-X', '--request', '-d', '--data', '--data-raw', '--upload-file'].includes(arg))) throw new Error('Smoke checks must be read-only');
const url = new URL(args.at(-1));
const responses = JSON.parse(fs.readFileSync(process.env.SMOKE_TEST_RESPONSES, 'utf8'));
const response = responses[url.pathname + url.search];
if (!response) throw new Error('Unexpected URL: ' + url.href);
const status = response.status || 200;
if (args.includes('--fail') && status >= 400) process.exit(22);
process.stdout.write(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
if (args.includes('--write-out')) process.stdout.write('\\n' + status);
`, { mode: 0o755 });
    const result = spawnSync('bash', [script, target, expected], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SMOKE_TEST_LOG: log, SMOKE_TEST_RESPONSES: join(directory, 'responses.json') },
    });
    let requests = [];
    try { requests = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ...result, requests };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('smoke accepts the original seed and checks the new pages and import endpoint using GET', () => {
  const result = smoke();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Berthday smoke test passed/);
  assert.deepEqual(result.requests.map(args => new URL(args.at(-1)).pathname), [
    '/api/health', '/api/meta', '/api/import/jobs', '/', '/issues', '/resources', '/import', '/api/does-not-exist',
  ]);
});

test('smoke accepts resources added to the original catalogue and existing import jobs', () => {
  const catalogue = meta();
  catalogue.berths.push(resource('visiting-floats'), { ...resource('west-floating-dock'), lengthFt: 120, isExclusive: true });
  const result = smoke({
    '/api/meta': { body: catalogue },
    '/api/import/jobs?limit=1': { body: { items: [{ id: 'job-1', name: 'Annual schedules', status: 'completed' }], nextCursor: 'next-page' } },
  });
  assert.equal(result.status, 0, result.stderr);
});

test('smoke rejects a missing seed resource even when another resource keeps the count at nine', () => {
  const catalogue = meta();
  catalogue.berths[0] = resource('new-dock');
  const result = smoke({ '/api/meta': { body: catalogue } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing seeded resource catalogue/);
});

test('smoke rejects a stale deployed version', () => {
  const result = smoke({}, url, 'different-version');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected health response/);
});

test('smoke rejects malformed import pagination', () => {
  const result = smoke({ '/api/import/jobs?limit=1': { body: { items: [], nextCursor: 17 } } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected import jobs response/);
});

test('smoke rejects a missing SPA root on the resource or import page', () => {
  for (const route of ['/resources', '/import']) {
    const result = smoke({ [route]: { body: 'Not an application page' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing SPA root/);
  }
});

test('smoke still requires a JSON NOT_FOUND response for an unknown API route', () => {
  const result = smoke({ '/api/does-not-exist': { body: { error: { code: 'OTHER' } }, status: 404 } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected JSON API 404/);
});

test('smoke rejects a different worker hostname before making any request', () => {
  const result = smoke({}, 'https://other.example.workers.dev');
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.requests, []);
});
