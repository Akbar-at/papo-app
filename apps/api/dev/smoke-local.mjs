import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = await mkdtemp(join(tmpdir(), 'photobooth-api-smoke-'));
const port = randomInt(20000, 40000);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'dev/local-server.ts'], {
  cwd: new URL('../', import.meta.url), env: { ...process.env, PHOTOBOOTH_DEV_DATA_DIR: stateDir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverError = '';
server.stderr.on('data', bytes => { serverError += String(bytes).slice(0, 2000); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async (path, method, data, credential) => {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined
  });
  return { status: response.status, data: await response.json() };
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Local server exited: ${serverError}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, `Local server did not start: ${serverError}`);
  const seed = JSON.parse(await readFile(join(stateDir, 'credentials.json'), 'utf8'));
  assert.equal((await fetch(`${origin}/docs`)).status, 200);
  const spec = await fetch(`${origin}/openapi.yaml`);
  assert.equal(spec.status, 200);
  assert.match(await spec.text(), /\/v1\/device\/sessions:/);
  const config = await json('/v1/device/configuration', 'GET', null, seed.device_credential);
  assert.equal(config.status, 200);
  const created = await json('/v1/device/sessions', 'POST', {
    client_session_id: randomUUID(), authorization: { kind: 'voucher', code: seed.voucher_code }
  }, seed.device_credential);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.session_id;
  assert.equal((await json(`/v1/device/sessions/${id}/frame`, 'PUT', { frame_version_id: seed.frame_version_id }, seed.device_credential)).status, 200);
  assert.equal((await json(`/v1/device/sessions/${id}/capture`, 'POST', { event_id: randomUUID(), photo_count: 3 }, seed.device_credential)).status, 200);
  assert.equal((await json(`/v1/device/sessions/${id}/prints`, 'POST', {
    event_id: randomUUID(), client_job_id: randomUUID(), status: 'confirmed', occurred_at: new Date().toISOString()
  }, seed.device_credential)).status, 201);
  assert.equal((await json(`/v1/device/sessions/${id}/finalize`, 'POST', null, seed.device_credential)).status, 409);
  for (const [kind, mime, bytes] of [
    ['composite', 'image/jpeg', Buffer.from([255, 216, 255, 217])],
    ['gif', 'image/gif', Buffer.from('GIF89a')]
  ]) {
    const intent = await json(`/v1/device/sessions/${id}/media-uploads`, 'POST', {
      kind, content_type: mime, byte_size: bytes.length, sha256: hash(bytes)
    }, seed.device_credential);
    assert.equal(intent.status, 200, JSON.stringify(intent.data));
    const uploaded = await fetch(intent.data.upload_url, { method: 'PUT', headers: { 'content-type': mime }, body: bytes });
    assert.equal(uploaded.status, 204);
  }
  const final = await json(`/v1/device/sessions/${id}/finalize`, 'POST', null, seed.device_credential);
  assert.equal(final.status, 200, JSON.stringify(final.data));
  const gallery = await fetch(final.data.share_url);
  assert.equal(gallery.status, 200);
  assert.equal((await gallery.json()).media.length, 2);
  console.log('PASS: health, Swagger, contract, configuration, voucher, frame, capture, print, uploads, QR gallery');
} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('exit', resolve));
  await rm(stateDir, { recursive: true, force: true });
}
