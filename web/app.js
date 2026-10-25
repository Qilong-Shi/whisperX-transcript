'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="local-token"]').content;
const extensions = /\.(mp3|wav|m4a|mp4|flac|aac|ogg|wma|mkv|mov|webm|opus|aiff)$/i;
let selectedFile = null;
let busy = false;
let ready = false;
let currentJob = null;
let pollTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-Local-Token': token } });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `请求失败（${response.status}）`);
  }
  return response;
}
function error(message) { $('error-message').textContent = message; $('error-message').hidden = !message; }
function updateButton() { $('start-button').disabled = busy || !selectedFile || !ready; }
function setBusy(value) { busy = value; $('settings-fields').disabled = value; updateButton(); }
function setStatus(title, description, running = false) {
  $('status-title').textContent = title; $('status-description').textContent = description;
  $('status-visual').classList.toggle('running', running);
}
function resetResults() {
  $('results').hidden = true; $('result-files').replaceChildren(); $('text-preview').hidden = true;
  $('result-indicator').className = 'indicator'; $('result-state').textContent = '待开始';
}
function selectFile(file) {
  if (busy) return;
  if (!file) {
    selectedFile = null; $('file-input').value = ''; $('file-summary').hidden = true;
    $('file-indicator').className = 'indicator'; $('file-state').textContent = '待选择';
    $('output-name').value = ''; resetResults(); error('');
    setStatus('准备好，记录下一段声音', '选择一个文件，即可开始转录。'); updateButton(); return;
  }
  if (!extensions.test(file.name)) { selectFile(null); error('请选择 MP3、WAV、M4A、MP4 等支持的音频或视频文件。'); return; }
  if (file.size === 0 || file.size > 4 * 1024 ** 3) { selectFile(null); error('文件不能为空，且单个文件不能超过 4 GB。'); return; }
  selectedFile = file; $('file-summary').hidden = false; $('file-name').textContent = file.name;
  $('file-size').textContent = file.size < 1024 ** 2 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 ** 2).toFixed(1)} MB`;
  $('output-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  $('file-indicator').className = 'indicator ok'; $('file-state').textContent = '已添加';
  resetResults(); error(''); setStatus('文件已准备好', '选择输出格式与保存位置，然后开始转录。'); updateButton();
}
async function refreshHealth() {
  try {
    const health = await (await api('/api/health')).json();
    ready = health.ready;
    if (!$('output-dir').value) $('output-dir').value = health.defaultOutputDir;
    $('environment-state').textContent = ready ? (health.cudaAvailable ? 'GPU 可用' : 'CPU 可用') : '需修复';
    $('environment-state').title = health.message;
    $('environment-indicator').className = `indicator ${ready ? 'ok' : 'bad'}`;
    if (!ready && !busy) { error(`${health.message}\n${health.detail || ''}`); }
    if (health.activeJob && !busy && health.activeJob !== currentJob) {
      currentJob = health.activeJob; setBusy(true); void poll();
    }
    updateButton();
  } catch (failure) {
    ready = false; $('environment-state').textContent = '连接中断';
    $('environment-indicator').className = 'indicator bad';
    if (!busy) error(`无法连接本机服务：${failure.message}。请保持启动窗口打开。`);
    updateButton();
  }
}
function upload(file, options) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/jobs?options=' + encodeURIComponent(JSON.stringify(options)));
    request.setRequestHeader('X-Local-Token', token);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.responseType = 'json';
    request.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      const percent = Math.round(event.loaded / event.total * 100);
      $('upload-progress').value = percent;
      setStatus(percent === 100 ? '正在准备转录' : `正在上传 · ${percent}%`, percent === 100 ? '等待本机服务确认文件与转录设置。' : '文件正在传送到本机转录服务。', true);
    };
    request.onerror = () => reject(new Error('连接中断，请确认本机启动窗口仍然打开。'));
    request.onabort = () => reject(new Error('文件上传已中断。'));
    request.onload = () => request.status === 202 ? resolve(request.response) : reject(new Error(request.response?.error || `上传失败（${request.status}）`));
    request.send(file);
  });
}
async function download(file, button) {
  button.disabled = true;
  try {
    const blob = await (await api(file.url)).blob();
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = href; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  } catch (failure) { error(failure.message); }
  finally { button.disabled = false; }
}
async function renderResults(job) {
  $('results').hidden = false; $('result-files').replaceChildren();
  $('saved-location').textContent = `已保存到：${job.outputDir}`;
  for (const file of job.files) {
    const row = document.createElement('div'); row.className = 'result-file';
    const name = document.createElement('span'); name.textContent = file.name;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '下载';
    button.addEventListener('click', () => download(file, button));
    row.append(name, button); $('result-files').append(row);
  }
  const textFile = job.files.find(file => file.name.endsWith('.txt'));
  if (textFile) {
    try {
      // Read only the first 32 KiB for the preview, even for lengthy recordings.
      const response = await api(textFile.url);
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      let preview = ''; let length = 0;
      while (length < 32768) {
        const { done, value } = await reader.read(); if (done) break;
        const part = value.subarray(0, 32768 - length); length += part.length;
        preview += decoder.decode(part, { stream: true });
      }
      await reader.cancel(); preview += decoder.decode();
      $('text-preview').textContent = preview + (length >= 32768 ? '\n… 下载文件查看完整内容' : '');
      $('text-preview').hidden = false;
    } catch { /* Saved files and download buttons remain available if preview fails. */ }
  }
}
async function poll() {
  clearTimeout(pollTimer);
  try {
    const job = await (await api(`/api/jobs/${currentJob}`)).json();
    $('upload-progress').hidden = true;
    const log = $('log-output'); const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = job.log || '正在加载模型；首次运行可能需要下载模型。';
    if (nearBottom) log.scrollTop = log.scrollHeight;
    if (job.state === 'completed') {
      setBusy(false); setStatus('转录完成，文字已就位', '结果已保存到本机，也可以直接下载。');
      $('result-indicator').className = 'indicator ok'; $('result-state').textContent = '已完成';
      await renderResults(job); return;
    }
    if (job.state === 'failed') {
      setBusy(false); setStatus('转录未完成', '查看日志中的错误信息，调整后可以重新尝试。');
      $('result-indicator').className = 'indicator bad'; $('result-state').textContent = '失败';
      error(job.error); $('logs').open = true; return;
    }
    setStatus('正在转录，请稍候', job.device === 'cpu' ? '正在使用 CPU；速度较慢，模型加载与识别可能需要几分钟。' : '模型加载与识别可能需要几分钟，运行日志会持续更新。', true);
    $('result-state').textContent = '处理中';
    pollTimer = setTimeout(poll, 1500);
  } catch (failure) {
    if (/任务不存在|会话已失效/.test(failure.message)) {
      setBusy(false); error(failure.message); setStatus('任务连接已失效', '请检查保存文件夹，或刷新页面重新提交。'); return;
    }
    setStatus('正在重新连接', '任务可能仍在本机运行。请保持启动窗口打开。', true);
    pollTimer = setTimeout(poll, 4000);
  }
}
$('drop-zone').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => selectFile(event.target.files[0]));
$('remove-file').addEventListener('click', () => selectFile(null));
for (const type of ['dragenter', 'dragover']) $('drop-zone').addEventListener(type, event => { event.preventDefault(); if (!busy) $('drop-zone').classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) $('drop-zone').addEventListener(type, event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); });
$('drop-zone').addEventListener('drop', event => {
  if (event.dataTransfer.files.length !== 1) { if (!busy) error('请一次选择一个文件。'); return; }
  selectFile(event.dataTransfer.files[0]);
});
// Prevent a dropped file outside the upload card from navigating away from the task.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
let folderState = null;
let folderRequest = null;
function folderError(message) { $('folder-error').textContent = message; $('folder-error').hidden = !message; }
function closeFolderDialog() {
  folderRequest?.abort(); folderRequest = null; $('folder-dialog').close();
}
async function loadFolders(directory, fallback = false) {
  folderRequest?.abort();
  const controller = new AbortController(); folderRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  folderState = null; folderError('');
  $('folder-path').value = directory;
  $('confirm-folder').disabled = true; $('folder-parent').disabled = true;
  $('folder-list').setAttribute('aria-busy', 'true'); $('folder-list').textContent = '正在读取文件夹…';
  try {
    const data = await (await api('/api/folders?path=' + encodeURIComponent(directory), { signal: controller.signal })).json();
    if (folderRequest !== controller || !$('folder-dialog').open) return;
    folderState = data; $('folder-path').value = data.path;
    $('folder-parent').disabled = !data.parent; $('confirm-folder').disabled = false;
    $('folder-roots').replaceChildren();
    for (const root of data.roots) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = root;
      button.addEventListener('click', () => loadFolders(root)); $('folder-roots').append(button);
    }
    $('folder-list').replaceChildren();
    if (!data.folders.length) $('folder-list').textContent = '此文件夹没有子文件夹，可以直接选择。';
    for (const folder of data.folders) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'folder-entry';
      const icon = document.createElement('span'); icon.textContent = '▱'; icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = folder.name;
      const arrow = document.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
      button.append(icon, name, arrow); button.addEventListener('click', () => loadFolders(folder.path));
      $('folder-list').append(button);
    }
  } catch (failure) {
    if (folderRequest !== controller || !$('folder-dialog').open) return;
    const message = failure.name === 'AbortError' ? '读取文件夹超时，请重试或输入其他路径。' : failure.message;
    if (fallback && directory) { await loadFolders(''); folderError(message + ' 已尝试打开默认位置。'); }
    else { $('folder-list').textContent = ''; folderError(message); }
  } finally {
    clearTimeout(timeout);
    if (folderRequest === controller) $('folder-list').setAttribute('aria-busy', 'false');
  }
}
$('pick-folder').addEventListener('click', () => {
  if (busy) return;
  error(''); $('folder-dialog').showModal();
  void loadFolders($('output-dir').value.trim(), true);
});
$('folder-path-form').addEventListener('submit', event => { event.preventDefault(); void loadFolders($('folder-path').value.trim()); });
$('folder-path').addEventListener('input', () => { $('confirm-folder').disabled = !folderState || $('folder-path').value.trim() !== folderState.path; });
$('folder-parent').addEventListener('click', () => { if (folderState?.parent) void loadFolders(folderState.parent); });
for (const id of ['close-folder', 'cancel-folder']) $(id).addEventListener('click', closeFolderDialog);
$('folder-dialog').addEventListener('cancel', event => { event.preventDefault(); closeFolderDialog(); });
$('confirm-folder').addEventListener('click', () => {
  if (!folderState || $('folder-path').value.trim() !== folderState.path) return;
  $('output-dir').value = folderState.path; closeFolderDialog();
});
$('transcribe-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!selectedFile || busy || !ready) return;
  error(''); resetResults();
  const options = { filename: selectedFile.name, outputName: $('output-name').value.trim(), outputDir: $('output-dir').value.trim(), format: document.querySelector('input[name="format"]:checked').value, language: $('language').value, model: $('model').value, device: $('device').value, computeType: $('compute-type').value, batchSize: Number($('batch-size').value) };
  setBusy(true); $('upload-progress').hidden = false; $('upload-progress').value = 0;
  setStatus('正在上传文件', '文件正在传送到本机转录服务。', true);
  $('log-output').textContent = '等待上传完成…';
  try { const job = await upload(selectedFile, options); currentJob = job.id; void poll(); }
  catch (failure) { setBusy(false); $('upload-progress').hidden = true; error(failure.message); setStatus('任务未能开始', '检查错误信息后可以重新尝试。'); }
});
void refreshHealth();
setInterval(refreshHealth, 30000);
