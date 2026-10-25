'use strict';

// Local-only server; no npm packages or changes to the WhisperX environment.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const MEDIA = new Set(['.mp3', '.wav', '.m4a', '.mp4', '.flac', '.aac', '.ogg', '.wma', '.mkv', '.mov', '.webm', '.opus', '.aiff']);
const FORMATS = new Set(['all', 'txt', 'srt', 'vtt', 'tsv', 'json']);
const MAX_UPLOAD = 4 * 1024 ** 3;
const MAX_LOG = 48000;
const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';

class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validStem(value) {
  const stem = String(value || '').trim();
  if (!stem || stem.length > 100 || /[<>:"/\\|?*\x00-\x1f]/.test(stem) || /[. ]$/.test(stem)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem) || stem === '..') {
    throw new RequestError('输出文件名不能包含路径、特殊字符或 Windows 保留名称，且最多 100 个字符。');
  }
  return stem;
}

function validateOptions(raw, root) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RequestError('转录设置无效。');
  const filename = String(raw.filename || '');
  if (!filename || path.basename(filename) !== filename || /[\\/\x00-\x1f]/.test(filename)) throw new RequestError('上传文件名无效。');
  const extension = path.extname(filename).toLowerCase();
  if (!MEDIA.has(extension)) throw new RequestError('请选择支持的音频或视频文件。');
  const stem = validStem(raw.outputName || path.parse(filename).name);
  const format = raw.format || 'all';
  const model = raw.model || 'large-v3';
  const language = raw.language ?? 'en';
  const computeType = raw.computeType || 'float16';
  const device = raw.device || 'auto';
  const batchSize = Number(raw.batchSize ?? 4);
  if (!FORMATS.has(format) || !['large-v3', 'medium', 'small', 'base', 'tiny', 'tiny.en'].includes(model)
      || !['', 'en', 'zh', 'ja', 'ko', 'fr', 'de', 'es'].includes(language)
      || !['float16', 'int8'].includes(computeType) || !['auto', 'cuda', 'cpu'].includes(device) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) {
    throw new RequestError('转录设置不在支持的范围内。');
  }
  const outputDir = raw.outputDir || path.join(root, 'output');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || /\x00/.test(outputDir)) throw new RequestError('保存位置必须是本机文件夹的绝对路径。');
  if (model === 'tiny.en' && !['', 'en'].includes(language)) throw new RequestError('tiny.en 只支持英语，请改用其他模型。');
  return { filename, extension, stem, format, model, language, device, computeType, batchSize, outputDir: path.resolve(outputDir) };
}

async function checkEnvironment(dataRoot) {
  const python = path.join(dataRoot, 'venv', 'Scripts', 'python.exe');
  try {
    await fsp.access(python);
    // Execute the venv rather than treating an existing file as a working install.
    const probe = await execute(python, ['-c', "import importlib.util, json, torch, ctranslate2; assert importlib.util.find_spec('whisperx'), 'WhisperX is missing'; print(json.dumps({'cudaAvailable': torch.cuda.is_available() and ctranslate2.get_cuda_device_count() > 0}))"], { windowsHide: true, timeout: 20000 });
    const { cudaAvailable } = JSON.parse(probe.stdout.trim());
    const ffmpegRoot = path.join(dataRoot, 'ffmpeg');
    const entries = await fsp.readdir(ffmpegRoot, { withFileTypes: true });
    const compatible = entries.filter(entry => entry.isDirectory() && /^ffmpeg-7\./.test(entry.name));
    let found = false;
    for (const entry of compatible) {
      try { await fsp.access(path.join(ffmpegRoot, entry.name, 'bin', 'ffmpeg.exe')); found = true; break; } catch {}
    }
    if (!found) throw new Error('FFmpeg Shared 7.x is missing');
    return { ready: true, cudaAvailable, message: cudaAvailable ? 'GPU 转录环境可启动' : 'CPU 可用；当前无法访问 CUDA，转录速度会较慢。', dataRoot };
  } catch (error) {
    return { ready: false, message: '转录环境不可用，请运行 setup.ps1 检查或修复。', detail: (error.stderr || error.message).slice(0, 2000), dataRoot };
  }
}

async function folderRoots() {
  const candidates = process.platform === 'win32'
    ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
    : ['/'];
  const results = await Promise.allSettled(candidates.map(candidate => fsp.stat(candidate)));
  return candidates.filter((candidate, index) => results[index].status === 'fulfilled' && results[index].value.isDirectory());
}

async function listFolders(directory, roots) {
  if (!path.isAbsolute(directory) || directory.includes('\0')) throw new RequestError('请输入文件夹的完整路径。');
  const resolved = path.resolve(directory);
  let entries;
  try { entries = await fsp.readdir(resolved, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new RequestError('这个文件夹不存在，请选择其他位置。', 404);
    if (['EACCES', 'EPERM'].includes(error.code)) throw new RequestError('无法访问这个文件夹，请选择有访问权限的位置。', 403);
    throw error;
  }
  const parent = path.dirname(resolved);
  return {
    path: resolved, parent: parent === resolved ? null : parent, roots,
    folders: entries.filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
      .map(entry => ({ name: entry.name, path: path.join(resolved, entry.name) })),
  };
}

function createApp(options = {}) {
  const root = options.root || __dirname;
  const dataRoot = options.dataRoot || process.env.WHISPERX_DATA_ROOT || 'D:\\AI\\WhisperX';
  const token = crypto.randomBytes(32).toString('hex');
  const jobs = new Map();
  let activeJob = null;
  let healthCache = null;
  let healthTime = 0;
  let rootsPromise = null;
  const environment = async () => {
    if (!healthCache || Date.now() - healthTime > 30000) {
      healthCache = await (options.checkEnvironment || checkEnvironment)(dataRoot);
      healthTime = Date.now();
    }
    return healthCache;
  };
  const launch = options.launchProcess || ((config) => spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'run-job.ps1'), '-Config', config], {
    cwd: root, windowsHide: true, env: { ...process.env, WHISPERX_DATA_ROOT: dataRoot, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
  }));
  function addLog(job, data) { job.log = (job.log + data.toString('utf8')).slice(-MAX_LOG); }
  function publicJob(job) {
    return { id: job.id, filename: job.filename, state: job.state, device: job.device, log: job.log, error: job.error, outputDir: job.outputDir, files: job.files };
  }
  async function run(job, config) {
    let child;
    try {
      child = launch(config);
      job.state = 'running';
      child.stdout.on('data', data => addLog(job, data));
      child.stderr.on('data', data => addLog(job, data));
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      if (code !== 0) throw new Error(`WhisperX 运行失败（退出码 ${code}），请查看下方日志。`);
      const names = await fsp.readdir(job.outputDir);
      job.files = names.filter(name => name.startsWith(job.stem + '.') && FORMATS.has(path.extname(name).slice(1)))
        .map(name => ({ name, url: `/api/jobs/${job.id}/files/${encodeURIComponent(name)}` }));
      if (!job.files.length) throw new Error('转录进程已结束，但没有生成预期的输出文件。');
      job.state = 'completed';
      // Uploads are temporary; retain failed uploads for troubleshooting.
      await fsp.unlink(job.audio).catch(() => {});
    } catch (error) {
      job.state = 'failed'; job.error = error.message; addLog(job, `\n${error.message}\n`);
    } finally { activeJob = null; }
  }
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value));
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== expectedHost) throw new RequestError('请通过启动器提供的本机地址访问。', 403);
      if (request.headers.origin && request.headers.origin !== `http://${expectedHost}`) throw new RequestError('不允许其他网站访问本机转录服务。', 403);
      const url = new URL(request.url, `http://${expectedHost}`);
      if (url.pathname.startsWith('/api/') && request.headers['x-local-token'] !== token) throw new RequestError('页面会话已失效，请刷新页面。', 403);
      if (request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        let body = await fsp.readFile(path.join(root, 'web', name));
        if (name === 'index.html') body = Buffer.from(body.toString('utf8').replace('__LOCAL_TOKEN__', token));
        response.writeHead(200, { 'Content-Type': { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' }[name] });
        response.end(body); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { ...await environment(), defaultOutputDir: path.join(root, 'output'), activeJob: activeJob?.id || null }); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/folders') {
        if (!rootsPromise) rootsPromise = folderRoots();
        let directory = url.searchParams.get('path');
        if (!directory) {
          directory = path.join(root, 'output');
          try { await fsp.access(directory); } catch { directory = root; }
        }
        json(response, 200, await listFolders(directory, await rootsPromise)); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/jobs') {
        if (activeJob) throw new RequestError('已有任务正在处理，请等它结束后再提交。', 409);
        let raw;
        try { raw = JSON.parse(url.searchParams.get('options')); } catch { throw new RequestError('无法读取转录设置。'); }
        const settings = validateOptions(raw, root);
        const size = Number(request.headers['content-length']);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD) throw new RequestError('请选择非空文件，单个文件不能超过 4 GB。', 413);
        if (request.headers['content-type'] !== 'application/octet-stream') throw new RequestError('上传数据类型无效。', 415);
        const id = crypto.randomUUID();
        const job = { id, filename: settings.filename, stem: settings.stem, state: 'uploading', log: '', files: [], error: null };
        activeJob = job; // Reserve the GPU slot before awaiting the environment check.
        let workDir;
        try {
          const health = await environment();
          if (!health.ready) throw new RequestError(`${health.message}\n${health.detail || ''}`, 503);
          settings.device = settings.device === 'auto' ? (health.cudaAvailable ? 'cuda' : 'cpu') : settings.device;
          if (settings.device === 'cuda' && !health.cudaAvailable) throw new RequestError('当前无法访问 CUDA，请在高级设置中选择自动或 CPU。', 503);
          if (settings.device === 'cpu') settings.computeType = 'int8';
          job.device = settings.device;
          addLog(job, `Device: ${settings.device}; compute type: ${settings.computeType}\n`);
          workDir = path.join(dataRoot, 'temp', 'web-ui', id);
          await fsp.mkdir(workDir, { recursive: true });
          job.audio = path.join(workDir, settings.stem + settings.extension);
          job.outputDir = path.join(settings.outputDir, `${settings.stem}-${id.slice(0, 8)}`);
          let received = 0;
          const limiter = new Transform({ transform(chunk, encoding, callback) {
            received += chunk.length;
            callback(received > size ? new Error('上传长度不符。') : null, chunk);
          } });
          await pipeline(request, limiter, fs.createWriteStream(job.audio, { flags: 'wx' }));
          if (received !== size) throw new RequestError('文件上传不完整，请重试。');
          await fsp.mkdir(job.outputDir, { recursive: true });
          const config = path.join(workDir, 'job.json');
          await fsp.writeFile(config, JSON.stringify({ ...settings, audio: job.audio, outputDir: job.outputDir }), { flag: 'wx' });
          jobs.set(id, job);
          // Keep a bounded in-memory history; saved output files remain on disk.
          if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
          void run(job, config);
          json(response, 202, publicJob(job));
        } catch (error) {
          activeJob = null;
          if (job.audio) await fsp.unlink(job.audio).catch(() => {});
          throw error;
        }
        return;
      }
      const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/files\/(.+))?$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const job = jobs.get(match[1]);
        if (!job) throw new RequestError('任务不存在或服务已重启，请在保存文件夹中查找结果。', 404);
        if (!match[2]) { json(response, 200, publicJob(job)); return; }
        const name = decodeURIComponent(match[2]);
        if (!job.files.some(file => file.name === name) || path.basename(name) !== name) throw new RequestError('输出文件不存在。', 404);
        const file = path.join(job.outputDir, name);
        const stat = await fsp.stat(file);
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
        await pipeline(fs.createReadStream(file), response); return;
      }
      throw new RequestError('地址不存在。', 404);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error.status || 500, { error: error.status ? error.message : `操作失败：${error.message}` });
      else response.destroy();
    }
  });
  server.requestTimeout = 0; // Large local uploads may take longer than the Node default.
  return server;
}

if (require.main === module) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 8765 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('Invalid port.'); process.exit(1); }
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Try .\\start-ui.ps1 -Port ${port + 1}` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`WhisperX UI: ${url}\nKeep this window open while transcribing. Ctrl+C to stop.`);
    if (process.argv.includes('--open')) {
      const opener = spawn(powershell, ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' });
      opener.on('error', error => console.error(`Open the URL above in your browser: ${error.message}`));
    }
  });
}

module.exports = { createApp, validateOptions, checkEnvironment };
