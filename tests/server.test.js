'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { createApp, validateOptions } = require('../server');

// A subprocess stands in for GPU inference; exercise the real HTTP/file pipeline.
async function fixture(t, { fail = false, missingOutput = false, ready = true, cudaAvailable = false, delay = 0 } = {}) {
  const temp = await fs.mkdtemp(path.join(__dirname, '..', 'output', 'ui-test-'));
  const server = createApp({
    dataRoot: temp,
    checkEnvironment: async () => ({ ready, cudaAvailable, message: ready ? 'ready' : 'installation unavailable' }),
    launchProcess: config => spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); const path = require('node:path');
      const options = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      console.log('subprocess started');
      setTimeout(() => {
        if (${fail}) { console.error('test inference failure'); process.exit(2); }
        if (!${missingOutput}) {
          for (const ext of options.format === 'all' ? ['txt', 'srt', 'vtt', 'tsv', 'json'] : [options.format]) {
            fs.writeFileSync(path.join(options.outputDir, options.stem + '.' + ext), '真实文件流程测试\\n');
          }
        }
      }, ${delay});
    `, config], { windowsHide: true }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base)).text();
  const token = /name="local-token" content="([a-f0-9]+)"/.exec(html)[1];
  const headers = { 'X-Local-Token': token };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Delete only this test's resolved temporary directory inside project/output.
    const allowed = path.resolve(__dirname, '..', 'output') + path.sep;
    assert.ok(path.resolve(temp).startsWith(allowed));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const settings = { filename: '访谈.wav', outputName: '课堂记录', outputDir: temp, language: '', format: 'all' };
  const upload = (custom = {}, data = Buffer.from('test media boundary')) => fetch(base + '/api/jobs?options=' + encodeURIComponent(JSON.stringify({ ...settings, ...custom })), {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: data,
  });
  return { base, headers, temp, upload };
}
async function finished(f, id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await fetch(`${f.base}/api/jobs/${id}`, { headers: f.headers })).json();
    if (['completed', 'failed'].includes(job.state)) return job;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Job did not finish');
}

test('serves the UI and requires a token, matching host and same origin', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/app.js')).status, 200);
  assert.equal((await fetch(f.base + '/api/health')).status, 403);
  assert.equal((await fetch(f.base + '/api/health', { headers: { ...f.headers, Origin: 'https://example.com' } })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(f.base + '/api/health', { headers: { ...f.headers, Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fetch(f.base + '/api/health', { headers: f.headers })).status, 200);
});
test('streams upload, runs subprocess, preserves Unicode names and downloads five formats', async t => {
  const f = await fixture(t);
  const response = await f.upload(); assert.equal(response.status, 202);
  const job = await finished(f, (await response.json()).id);
  assert.equal(job.state, 'completed'); assert.equal(job.files.length, 5);
  assert.equal(job.device, 'cpu'); assert.match(job.log, /compute type: int8/);
  assert.ok(job.log.includes('subprocess started'));
  assert.ok(job.outputDir.startsWith(f.temp + path.sep));
  for (const file of job.files) {
    assert.ok(file.name.startsWith('课堂记录.'));
    const download = await fetch(f.base + file.url, { headers: f.headers });
    assert.equal(download.status, 200); assert.equal(await download.text(), '真实文件流程测试\n');
    assert.ok(download.headers.get('Content-Disposition').includes("filename*=UTF-8''"));
  }
  const attempt = await fetch(`${f.base}/api/jobs/${job.id}/files/${encodeURIComponent('..\\job.json')}`, { headers: f.headers });
  assert.equal(attempt.status, 404);
  const workDir = path.join(f.temp, 'temp', 'web-ui', job.id);
  await assert.rejects(fs.access(path.join(workDir, '课堂记录.wav')));
});
test('selecting TXT produces only TXT and separate jobs cannot overwrite each other', async t => {
  const f = await fixture(t);
  const first = await finished(f, (await (await f.upload({ format: 'txt' })).json()).id);
  const second = await finished(f, (await (await f.upload({ format: 'txt' })).json()).id);
  assert.equal(first.files.length, 1); assert.ok(first.files[0].name.endsWith('.txt'));
  assert.notEqual(first.outputDir, second.outputDir);
  assert.equal(await fs.readFile(path.join(first.outputDir, first.files[0].name), 'utf8'), '真实文件流程测试\n');
});
test('GPU slot rejects simultaneous jobs and releases after completion', async t => {
  const f = await fixture(t, { delay: 300 });
  const first = await f.upload(); assert.equal(first.status, 202);
  const id = (await first.json()).id;
  assert.equal((await f.upload()).status, 409);
  assert.equal((await (await fetch(f.base + '/api/health', { headers: f.headers })).json()).activeJob, id);
  await finished(f, id);
  assert.equal((await (await fetch(f.base + '/api/health', { headers: f.headers })).json()).activeJob, null);
});
test('nonzero inference exit reports failure and releases the slot', async t => {
  const f = await fixture(t, { fail: true });
  const job = await finished(f, (await (await f.upload()).json()).id);
  assert.equal(job.state, 'failed'); assert.match(job.error, /退出码 2/);
  assert.match(job.log, /test inference failure/); assert.equal(job.files.length, 0);
  assert.equal((await (await fetch(f.base + '/api/health', { headers: f.headers })).json()).activeJob, null);
});
test('success exit without output is a failure', async t => {
  const f = await fixture(t, { missingOutput: true });
  const job = await finished(f, (await (await f.upload()).json()).id);
  assert.equal(job.state, 'failed'); assert.match(job.error, /没有生成/);
});
test('unavailable environment returns a real setup error before starting work', async t => {
  const f = await fixture(t, { ready: false });
  const response = await f.upload(); assert.equal(response.status, 503);
  assert.match((await response.json()).error, /installation unavailable/);
});
test('rejects unsupported files, invalid settings, empty and oversize uploads', async t => {
  const f = await fixture(t);
  for (const settings of [{ filename: 'script.exe' }, { filename: '../audio.wav' }, { outputName: '..\\outside' }, { outputName: 'CON' }, { outputDir: 'relative' }, { format: 'exe' }, { model: 'bad' }, { batchSize: 65 }, { language: 'bad' }, { device: 'bad' }, { model: 'tiny.en', language: 'zh' }]) {
    const response = await f.upload(settings); assert.equal(response.status, 400, JSON.stringify(settings));
  }
  assert.equal((await f.upload({}, Buffer.alloc(0))).status, 413);
  const response = await fetch(f.base + '/api/jobs?options=' + encodeURIComponent(JSON.stringify({ filename: 'x.wav', outputDir: f.temp })), {
    method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(4 * 1024 ** 3 + 1) },
  });
  assert.equal(response.status, 413);
});
test('explicit GPU mode reports unavailable CUDA, while automatic mode runs on CPU', async t => {
  const f = await fixture(t);
  const response = await f.upload({ device: 'cuda' });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /CUDA/);
  const job = await finished(f, (await (await f.upload()).json()).id);
  assert.equal(job.state, 'completed'); assert.equal(job.device, 'cpu');
});
test('folder browser lists only directories, preserves Unicode paths and navigates to parent', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.temp, '课堂记录'));
  await fs.writeFile(path.join(f.temp, 'not-a-folder.txt'), 'test');
  const browse = directory => fetch(f.base + '/api/folders?path=' + encodeURIComponent(directory), { headers: f.headers });
  const response = await browse(f.temp);
  assert.equal(response.status, 200);
  const listing = await response.json();
  assert.equal(listing.path, f.temp); assert.equal(listing.parent, path.dirname(f.temp));
  assert.deepEqual(listing.folders, [{ name: '课堂记录', path: path.join(f.temp, '课堂记录') }]);
  assert.ok(listing.roots.includes(path.parse(f.temp).root));
  const child = await (await browse(listing.folders[0].path)).json();
  assert.equal(child.parent, f.temp); assert.equal(child.folders.length, 0);
  assert.equal((await browse(path.join(f.temp, 'missing'))).status, 404);
  assert.equal((await browse(path.join(f.temp, 'not-a-folder.txt'))).status, 404);
  assert.equal((await browse('relative/path')).status, 400);
  assert.equal((await fetch(f.base + '/api/folders')).status, 403);
  const defaultLocation = await (await browse('')).json();
  assert.ok(path.isAbsolute(defaultLocation.path));
  assert.equal((await fetch(f.base + '/api/jobs/00000000', { headers: f.headers })).status, 404);
});
test('available GPU uses selected precision, and explicit CPU mode writes int8 configuration', async t => {
  const f = await fixture(t, { cudaAvailable: true });
  const gpu = await finished(f, (await (await f.upload()).json()).id);
  const gpuConfig = JSON.parse(await fs.readFile(path.join(f.temp, 'temp', 'web-ui', gpu.id, 'job.json'), 'utf8'));
  assert.equal(gpu.device, 'cuda'); assert.equal(gpuConfig.device, 'cuda'); assert.equal(gpuConfig.computeType, 'float16');
  const cpu = await finished(f, (await (await f.upload({ device: 'cpu' })).json()).id);
  const cpuConfig = JSON.parse(await fs.readFile(path.join(f.temp, 'temp', 'web-ui', cpu.id, 'job.json'), 'utf8'));
  assert.equal(cpu.device, 'cpu'); assert.equal(cpuConfig.computeType, 'int8');
});
test('validates all allowed formats, automatic language, and default options', () => {
  for (const format of ['all', 'txt', 'srt', 'vtt', 'tsv', 'json']) {
    const result = validateOptions({ filename: 'recording.MP4', format, language: '' }, __dirname);
    assert.equal(result.extension, '.mp4'); assert.equal(result.format, format); assert.equal(result.language, '');
    assert.equal(result.model, 'large-v3'); assert.equal(result.batchSize, 4);
  }
});
