'use strict';
// M10：只获取独立候选，绝不运行更新命令、安装器或候选程序。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const ROOT = path.resolve(__dirname, '..');
const STAGING_ROOTS = Object.freeze([
  path.join(ROOT, 'data', 'maintenance', 'candidates'),
  path.join(ROOT, 'logs', 'auto-maintain-validation', 'candidates'),
]);
const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases';
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const METADATA_LIMIT = 64 * 1024;
const SIGNERS = { claude: 'Anthropic, PBC', codex: 'OpenAI OpCo, LLC' };
class CandidateError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new CandidateError(code); };
const programName = program => String(typeof program === 'string' ? program : program?.name || '').toLowerCase();
const contained = (base, file) => { const relative = path.relative(base, file); return !!relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const outcome = error => ({ status: 'failed', reason: error instanceof CandidateError ? error.code : 'candidate-unavailable' });

function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return false;
  if (url.hostname === 'downloads.claude.ai')
    return /^\/claude-code-releases\/(?:latest|\d{1,6}\.\d{1,6}\.\d{1,6}\/(?:manifest\.json|win32-(?:x64|arm64)\/claude\.exe))$/.test(url.pathname);
  if (url.hostname === 'releases.openai.com')
    return /^\/codex\/(?:channels\/latest|releases\/\d{1,6}\.\d{1,6}\.\d{1,6}\/(?:release\.json|codex-package_SHA256SUMS|codex-package-(?:x86_64|aarch64)-pc-windows-msvc\.tar\.gz))$/.test(url.pathname);
  return false;
}
async function responseFor(url, options, limit, timeoutMs) {
  if (!allowedUrl(url)) fail('source-not-allowed');
  const available = options.remainingBudget ? options.remainingBudget() : timeoutMs;
  timeoutMs = Math.min(timeoutMs, available);
  if (!(timeoutMs > 0)) fail('budget-exhausted');
  let response;
  try {
    response = await (options.request || fetch)(url, {
      method: 'GET', redirect: 'manual', headers: { 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    });
  } catch { fail('network-failed'); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('redirect-not-allowed'); }
  if (response.status !== 200) { await response.body?.cancel(); fail('download-http-failed'); }
  // 即使注入的传输层意外跟随了重定向，也拒绝改源后的响应。
  if (response.url && response.url !== url) { await response.body?.cancel(); fail('redirect-not-allowed'); }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel(); fail('download-too-large');
  }
  if (!response.body) fail('empty-download');
  return response;
}
async function readSmall(url, options, limit = METADATA_LIMIT) {
  const response = await responseFor(url, options, limit, 20000);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('metadata-too-large');
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error instanceof CandidateError ? error : new CandidateError('invalid-metadata');
  }
}
function claudeRelease(manifest, version, platform) {
  if (!manifest || manifest.version !== version || !VERSION.test(version)) fail('manifest-version-mismatch');
  const asset = manifest.platforms?.[platform];
  if (!asset || asset.binary !== 'claude.exe' || typeof asset.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.checksum) || !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 || asset.size > MAX_BINARY_BYTES) fail('invalid-manifest-asset');
  return {
    status: 'available', program: 'claude', version, platform,
    download: { url: CLAUDE_BASE + '/' + version + '/' + platform + '/claude.exe',
      sha256: asset.checksum, size: asset.size, format: 'native-executable' },
    provenance: { source: 'anthropic-release-manifest', manifestUrl: CLAUDE_BASE + '/' + version + '/manifest.json',
      metadataTransport: 'https', manifestSignature: 'not-verified' },
  };
}
async function discover(program, options = {}) {
  const name = programName(program);
  if (name === 'codex') return discoverCodex(options);
  if (name !== 'claude') return { status: 'unsupported', program: name, reason: 'program-unsupported' };
  const platform = options.platform || process.platform + '-' + process.arch;
  if (!['win32-x64', 'win32-arm64'].includes(platform))
    return { status: 'unsupported', program: name, reason: 'platform-unsupported' };
  try {
    let version = options.version;
    if (version === undefined) version = (await readSmall(CLAUDE_BASE + '/latest', options, 64)).trim();
    if (typeof version !== 'string' || !VERSION.test(version)) fail('invalid-release-version');
    let manifest;
    try { manifest = JSON.parse(await readSmall(CLAUDE_BASE + '/' + version + '/manifest.json', options)); }
    catch (error) { if (error instanceof CandidateError) throw error; fail('invalid-manifest'); }
    return claudeRelease(manifest, version, platform);
  } catch (error) { return outcome(error); }
}
async function assertPlainAncestors(target, io, create = false, createdDirectories) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail('unsafe-destination');
    current = path.join(current, part);
    let stat;
    try { stat = await io.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      let made = false;
      try { await io.mkdir(current); made = true; } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await io.lstat(current);
      if (made && createdDirectories) createdDirectories.push({ directory: current, identity: stat });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('linked-destination');
  }
}
function destinationPath(destination, options) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) fail('unsafe-destination');
  const resolved = path.resolve(destination);
  if (!resolved.slice(path.parse(resolved).root.length).split(path.sep).every(safePart)) fail('unsafe-destination');
  const stagingRoot = options.stagingRoot ? path.resolve(options.stagingRoot) : STAGING_ROOTS[0];
  if (!STAGING_ROOTS.some(base => stagingRoot === base || contained(base, stagingRoot)) ||
      !contained(stagingRoot, resolved)) fail('destination-outside-staging');
  return { resolved, stagingRoot };
}
async function nativeSignedBy(file, signer) {
  if (process.platform !== 'win32' || !Object.values(SIGNERS).includes(signer)) return false;
  const command = '$s=Get-AuthenticodeSignature -LiteralPath $env:RELAY_SIGNED_FILE; if($s.Status -eq \'Valid\' -and $s.SignerCertificate.Subject -like (\'*O="\' + $env:RELAY_SIGNER + \'"*\')){exit 0}else{exit 1}';
  return new Promise(resolve => {
    let child;
    try {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      child = cp.spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true, stdio: 'ignore',
        env: { ...process.env, RELAY_SIGNED_FILE: file, RELAY_SIGNER: signer },
      });
    } catch { resolve(false); return; }
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 120000);
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
  });
}
async function writeAll(handle, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
    if (!(bytesWritten > 0)) fail('candidate-write-failed');
    offset += bytesWritten;
  }
}
const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].map(String).join(':');
const plainFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
async function verifyFile(file, expectedHash, expectedIdentity, io) {
  // 摘要绑定实际内容；时间和 inode 核对用于拒绝读取期间的替换或重写。
  for await (const unused of fileChunks(file, io, expectedHash, expectedIdentity)) void unused;
}
async function verifyExtractedTree(directory, createdFiles, createdDirectories, io) {
  const expected = new Map();
  for (const entry of createdDirectories) if (entry.directory === directory || contained(directory, entry.directory))
    expected.set(entry.directory.toLowerCase(), { type: 'directory', identity: entry.identity });
  for (const entry of createdFiles) expected.set(entry.file.toLowerCase(), { type: 'file', identity: entry.identity, completed: entry.completed });
  const seen = new Set();
  async function visit(file) {
    const key = file.toLowerCase(), entry = expected.get(key), stat = await io.lstat(file);
    if (!entry || seen.has(key) || stat.isSymbolicLink() || stat.dev !== entry.identity.dev || stat.ino !== entry.identity.ino)
      fail('candidate-changed-during-check');
    seen.add(key);
    if (entry.type === 'directory') {
      if (!stat.isDirectory()) fail('candidate-changed-during-check');
      for (const name of await io.readdir(file)) {
        if (!safePart(name)) fail('candidate-changed-during-check');
        await visit(path.join(file, name));
      }
    } else if (!plainFile(stat) || entry.completed && fileIdentity(stat) !== fileIdentity(entry.completed)) {
      fail('candidate-changed-during-check');
    }
  }
  await visit(directory);
  if (seen.size !== expected.size) fail('candidate-changed-during-check');
}
async function receiveBinary(release, file, options, io, onCreated) {
  const response = await responseFor(release.download.url, options, release.download.size || MAX_BINARY_BYTES, 600000);
  let handle;
  try { handle = await io.open(file, 'wx', 0o600); }
  catch (error) { try { await response.body.cancel(); } catch {} throw error; }
  const reader = response.body.getReader(), hash = crypto.createHash('sha256');
  let size = 0;
  try {
    if (onCreated) onCreated(await handle.stat());
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if ((release.download.size !== null && size > release.download.size) || size > MAX_BINARY_BYTES) fail('download-too-large');
      hash.update(value);
      await writeAll(handle, value);
    }
    if (release.download.size !== null && size !== release.download.size) fail('download-size-mismatch');
    if (hash.digest('hex') !== release.download.sha256) fail('checksum-mismatch');
    await handle.sync();
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  } finally { await handle.close(); }
}
async function removeOwned(entry, io) {
  try {
    await assertPlainAncestors(path.dirname(entry.file), io);
    const stat = await io.lstat(entry.file);
    if (stat.ino === entry.identity.ino && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
      await io.unlink(entry.file);
  } catch {}
}
async function prepareCandidate(program, destination, options = {}) {
  const name = programName(program);
  if (!['claude', 'codex'].includes(name)) return discover(program, options);
  const io = options.fs || fs;
  let target, created = false, assetPath;
  const createdFiles = [], createdDirectories = [];
  try {
    target = destinationPath(destination, options).resolved;
    await assertPlainAncestors(path.dirname(target), io);
    try { await io.lstat(target); fail('destination-exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const release = await discover(program, options);
    if (release.status !== 'available') return release;
    await assertPlainAncestors(path.dirname(target), io, true, createdDirectories);
    await io.mkdir(target);
    created = true;
    createdDirectories.push({ directory: target, identity: await io.lstat(target) });
    assetPath = path.join(target, name === 'claude' ? 'claude.exe' : '.codex-package.tar.gz');
    await receiveBinary(release, assetPath, options, io, identity => { createdFiles.push({ file: assetPath, identity }); });
    const before = await io.lstat(assetPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (release.download.size !== null && before.size !== release.download.size)) fail('unsafe-candidate-file');
    let executable = assetPath, filesVerified = 1;
    if (name === 'codex') {
      const unpacked = await extractCodex(assetPath, target, release, options, io, createdFiles, createdDirectories, before);
      executable = unpacked.executable; filesVerified = unpacked.filesVerified;
      await removeOwned(createdFiles[0], io);
    } else {
      if (!await (options.signedBy || nativeSignedBy)(assetPath, SIGNERS.claude)) fail('signature-mismatch');
      await assertPlainAncestors(target, io);
      await verifyFile(assetPath, release.download.sha256, before, io);
    }
    return { ...release, status: 'ready', executable, candidateRoot: target, filesVerified,
      provenance: { ...release.provenance, sha256Verified: true, authenticodeVerified: true, signer: SIGNERS[name] } };
  } catch (error) {
    if (created) {
      for (const entry of createdFiles.reverse()) await removeOwned(entry, io);
      for (const entry of createdDirectories.reverse()) {
        try {
          await assertPlainAncestors(entry.directory, io);
          const stat = await io.lstat(entry.directory);
          if (stat.ino === entry.identity.ino && stat.isDirectory() && !stat.isSymbolicLink()) await io.rmdir(entry.directory);
        } catch {}
      }
    }
    return outcome(error);
  }
}
// 获取失败和 --version 不可读共用连续计数。成功清零；第三次只产生一次通知信号。
function recordAcquisitionResult(previous = {}, result = {}) {
  if (result.ok === true) return { consecutiveFailures: 0, notified: false, notify: false, reason: null };
  const prior = Number.isSafeInteger(previous.consecutiveFailures) && previous.consecutiveFailures > 0
    ? Math.min(previous.consecutiveFailures, 1000000) : 0;
  const consecutiveFailures = Math.min(prior + 1, 1000000);
  const notify = consecutiveFailures >= 3 && previous.notified !== true;
  const reason = ['version-unreadable', 'download-failed', 'unsupported', 'signature-mismatch', 'checksum-mismatch'].includes(result.reason)
    ? result.reason : 'download-failed';
  return { consecutiveFailures, notified: previous.notified === true || notify, notify, reason };
}
module.exports = { discover, prepareCandidate, recordAcquisitionResult, STAGING_ROOTS };

const CODEX_BASE = 'https://releases.openai.com/codex';
const CODEX_METADATA_LIMIT = 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024, MAX_ARCHIVE_ENTRIES = 2048;
// 官方 0.167.0 起每个条目前带一个 PAX 扩展头，内容只有 mtime。只接受时间字段；
// 能改路径、链接、大小、属主或字符集的字段一律拒绝，时间值本身不使用。
const PAX_LIMIT = 4096, PAX_TIME_KEYS = new Set(['mtime', 'atime', 'ctime']);
function checkPaxRecords(data) {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0 || space - at < 1 || space - at > 5) fail('archive-invalid-pax');
    const lengthText = data.toString('ascii', at, space);
    if (!/^[1-9]\d*$/.test(lengthText)) fail('archive-invalid-pax');
    const length = Number(lengthText), end = at + length;
    if (end > data.length || data[end - 1] !== 0x0a) fail('archive-invalid-pax');
    const record = data.toString('ascii', space + 1, end - 1), equals = record.indexOf('=');
    if (equals < 1 || !PAX_TIME_KEYS.has(record.slice(0, equals)) || !/^\d{1,20}(?:\.\d{1,9})?$/.test(record.slice(equals + 1)))
      fail('archive-pax-field-not-allowed');
    at = end;
  }
}
async function discoverCodex(options) {
  const platform = options.platform || process.platform + '-' + process.arch;
  const target = { 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' }[platform];
  if (!target) return { status: 'unsupported', program: 'codex', reason: 'platform-unsupported' };
  try {
    let version = options.version;
    if (version === undefined) {
      const channel = JSON.parse(await readSmall(CODEX_BASE + '/channels/latest', options, CODEX_METADATA_LIMIT));
      if (typeof channel.tag_name !== 'string' || !/^rust-v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(channel.tag_name))
        fail('invalid-release-version');
      version = channel.tag_name.slice(6);
    }
    if (typeof version !== 'string' || !VERSION.test(version)) fail('invalid-release-version');
    const base = CODEX_BASE + '/releases/' + version;
    const release = JSON.parse(await readSmall(base + '/release.json', options, CODEX_METADATA_LIMIT));
    if (release.tag_name !== 'rust-v' + version || !Array.isArray(release.assets)) fail('manifest-version-mismatch');
    const packageName = 'codex-package-' + target + '.tar.gz', sumsName = 'codex-package_SHA256SUMS';
    const getAsset = name => {
      const rows = release.assets.filter(asset => asset?.name === name);
      if (rows.length !== 1 || typeof rows[0].digest !== 'string' ||
          !/^sha256:[a-fA-F0-9]{64}$/.test(rows[0].digest) ||
          rows[0].browser_download_url !== base + '/' + name) fail('invalid-manifest-asset');
      return rows[0];
    };
    const archive = getAsset(packageName), sums = getAsset(sumsName);
    const sumsText = await readSmall(sums.browser_download_url, options);
    const sumsHash = crypto.createHash('sha256').update(sumsText, 'utf8').digest('hex');
    if (sumsHash !== sums.digest.slice(7).toLowerCase()) fail('checksum-manifest-mismatch');
    const matches = sumsText.split(/\r?\n/).filter(line => line.endsWith('  ' + packageName));
    if (matches.length !== 1 || !/^[a-fA-F0-9]{64}  [A-Za-z0-9_.-]+$/.test(matches[0]))
      fail('invalid-checksum-manifest');
    const sha256 = matches[0].slice(0, 64).toLowerCase();
    if (sha256 !== archive.digest.slice(7).toLowerCase()) fail('archive-digest-mismatch');
    return {
      status: 'available', program: 'codex', version, platform, target,
      download: { url: archive.browser_download_url, sha256, size: null, maxBytes: MAX_BINARY_BYTES, format: 'tar.gz' },
      provenance: { source: 'openai-release-json-and-sha256sums', manifestUrl: base + '/release.json',
        checksumsUrl: sums.browser_download_url, checksumsSha256Verified: true,
        metadataTransport: 'https', manifestSignature: 'not-verified' },
    };
  } catch (error) { return outcome(error); }
}
function safePart(part) {
  return !!part && part !== '.' && part !== '..' && !/[<>:"|?*\\\x00-\x1f]/.test(part) &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
}
function tarText(header, start, length) {
  const bytes = header.subarray(start, start + length);
  const zero = bytes.indexOf(0);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(zero < 0 ? bytes : bytes.subarray(0, zero)); }
  catch { fail('archive-invalid-name'); }
}
function tarNumber(header, start, length) {
  const value = tarText(header, start, length).trim();
  if (!/^[0-7]+$/.test(value || '0')) fail('archive-unsupported-number');
  const number = parseInt(value || '0', 8);
  if (!Number.isSafeInteger(number)) fail('archive-unsupported-number');
  return number;
}
async function* fileChunks(file, io, expectedHash, expectedIdentity) {
  await assertPlainAncestors(path.dirname(file), io);
  const before = await io.lstat(file);
  if (!plainFile(before) || fileIdentity(before) !== fileIdentity(expectedIdentity)) fail('candidate-changed-during-check');
  const handle = await io.open(file, 'r');
  try {
    if (!plainFile(await handle.stat()) || fileIdentity(await handle.stat()) !== fileIdentity(before)) fail('candidate-changed-during-check');
    const buffer = Buffer.alloc(65536), hash = crypto.createHash('sha256');
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > before.size || size > MAX_BINARY_BYTES) fail('candidate-changed-during-check');
      hash.update(buffer.subarray(0, bytesRead));
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
    await assertPlainAncestors(path.dirname(file), io);
    const after = await io.lstat(file), opened = await handle.stat();
    if (!plainFile(after) || !plainFile(opened) || size !== before.size ||
        fileIdentity(after) !== fileIdentity(before) || fileIdentity(opened) !== fileIdentity(before) ||
        hash.digest('hex') !== expectedHash) fail('candidate-changed-during-check');
  } finally { await handle.close(); }
}
async function extractCodex(archive, directory, release, options, io, createdFiles, createdDirectories, archiveIdentity) {
  // 解压器真正读取的压缩字节也必须匹配官方摘要，不能只相信下载时曾经匹配。
  const input = Readable.from(fileChunks(archive, io, release.download.sha256, archiveIdentity)), unzip = zlib.createGunzip();
  input.on('error', error => unzip.destroy(error));
  input.pipe(unzip);
  let buffered = Buffer.alloc(0), expanded = 0, entries = 0, zeros = 0, ended = false;
  let handle = null, remaining = 0, padding = 0, currentFile = null;
  let paxRemaining = 0, paxPadding = 0, paxChunks = [], paxPending = false;
  const names = new Set();
  try {
    for await (const chunk of unzip) {
      expanded += chunk.length;
      if (expanded > MAX_EXPANDED_BYTES) fail('archive-expanded-too-large');
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (ended) {
          if (buffered.some(byte => byte !== 0)) fail('archive-trailing-data');
          buffered = Buffer.alloc(0); break;
        }
        if (remaining > 0) {
          if (!buffered.length) break;
          const count = Math.min(remaining, buffered.length);
          currentFile.hash.update(buffered.subarray(0, count));
          await writeAll(handle, buffered.subarray(0, count));
          remaining -= count; buffered = buffered.subarray(count);
          if (remaining === 0) {
            await handle.sync(); currentFile.completed = await handle.stat();
            currentFile.sha256 = currentFile.hash.digest('hex'); delete currentFile.hash;
            await handle.close(); handle = null;
          }
          continue;
        }
        if (paxRemaining > 0) {
          if (!buffered.length) break;
          const count = Math.min(paxRemaining, buffered.length);
          paxChunks.push(Buffer.from(buffered.subarray(0, count)));
          paxRemaining -= count; buffered = buffered.subarray(count);
          if (paxRemaining === 0) { checkPaxRecords(Buffer.concat(paxChunks)); paxChunks = []; paxPending = true; padding = paxPadding; }
          continue;
        }
        if (padding > 0) {
          if (!buffered.length) break;
          const count = Math.min(padding, buffered.length);
          if (buffered.subarray(0, count).some(byte => byte !== 0)) fail('archive-invalid-padding');
          padding -= count; buffered = buffered.subarray(count); continue;
        }
        if (buffered.length < 512) break;
        const header = buffered.subarray(0, 512); buffered = buffered.subarray(512);
        if (header.every(byte => byte === 0)) { zeros++; if (zeros === 2) ended = true; continue; }
        if (zeros) fail('archive-invalid-terminator');
        if (++entries > MAX_ARCHIVE_ENTRIES) fail('archive-too-many-entries');
        const expectedChecksum = tarNumber(header, 148, 8);
        let actualChecksum = 0;
        for (let i = 0; i < 512; i++) actualChecksum += i >= 148 && i < 156 ? 32 : header[i];
        if (actualChecksum !== expectedChecksum || header.toString('ascii', 257, 262) !== 'ustar')
          fail('archive-invalid-header');
        const type = header[156];
        if (type === 120) { // 'x'：只作用于下一个条目的 PAX 扩展头
          const paxSize = tarNumber(header, 124, 12);
          if (paxPending || tarText(header, 157, 100) || !(paxSize > 0 && paxSize <= PAX_LIMIT)) fail('archive-invalid-pax');
          paxRemaining = paxSize; paxPadding = (512 - paxSize % 512) % 512; continue;
        }
        if (![0, 48, 53].includes(type) || tarText(header, 157, 100)) fail('archive-links-or-type-not-allowed');
        paxPending = false;
        const prefix = header[262] === 0 ? tarText(header, 345, 155) : ''; // GNU格式该区域不是路径前缀。
        let name = (prefix ? prefix + '/' : '') + tarText(header, 0, 100);
        while (name.startsWith('./')) name = name.slice(2);
        if (type === 53) name = name.replace(/\/$/, '');
        const size = tarNumber(header, 124, 12);
        if (type === 53 && size !== 0) fail('archive-invalid-directory');
        if (size > MAX_BINARY_BYTES) fail('archive-file-too-large');
        if ((!name || name === '.') && type === 53) continue;
        const segments = name.split('/');
        if (name.length > 512 || !segments.every(safePart)) fail('archive-unsafe-path');
        const folded = name.toLowerCase();
        if (names.has(folded)) fail('archive-duplicate-path');
        names.add(folded);
        const file = path.resolve(directory, ...segments);
        if (!contained(directory, file)) fail('archive-unsafe-path');
        if (type === 53) { await assertPlainAncestors(file, io, true, createdDirectories); continue; }
        await assertPlainAncestors(path.dirname(file), io, true, createdDirectories);
        handle = await io.open(file, 'wx', 0o600);
        currentFile = { file, identity: await handle.stat(), hash: crypto.createHash('sha256') };
        createdFiles.push(currentFile);
        remaining = size; padding = (512 - size % 512) % 512;
        if (remaining === 0) {
          currentFile.completed = await handle.stat();
          currentFile.sha256 = currentFile.hash.digest('hex'); delete currentFile.hash;
          await handle.close(); handle = null;
        }
      }
    }
    if (!ended || remaining || padding || paxRemaining || paxPending || handle || buffered.length) fail('archive-truncated');
  } finally {
    input.destroy(); unzip.destroy();
    if (handle) { try { await handle.close(); } catch {} }
  }
  const metadataPath = path.join(directory, 'codex-package.json');
  const metadataStat = await io.lstat(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1 || metadataStat.size > 16384)
    fail('invalid-package-metadata');
  let metadata;
  try { metadata = JSON.parse(await io.readFile(metadataPath, 'utf8')); } catch { fail('invalid-package-metadata'); }
  if (metadata.layoutVersion !== 1 || metadata.version !== release.version || metadata.target !== release.target ||
      metadata.variant !== 'codex' || metadata.entrypoint !== 'bin/codex.exe' ||
      metadata.execServer !== 'bin/codex-exec-server.exe' ||
      metadata.resourcesDir !== 'codex-resources' || metadata.pathDir !== 'codex-path')
    fail('package-layout-mismatch');
  const required = ['bin/codex.exe', 'bin/codex-code-mode-host.exe', 'bin/codex-exec-server.exe',
    'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'];
  for (const relative of required) {
    const stat = await io.lstat(path.join(directory, relative));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0) fail('package-incomplete');
  }
  // 保留原维护器的四项发布方校验；辅助程序存在性另按官方完整包规则检查。
  for (const relative of ['bin/codex.exe', 'bin/codex-exec-server.exe',
    'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe']) {
    if (!await (options.signedBy || nativeSignedBy)(path.join(directory, relative), SIGNERS.codex))
      fail('signature-mismatch');
  }
  for (const entry of createdFiles) {
    if (!entry.completed) continue; // 原始归档由外层单独检查。
    await verifyFile(entry.file, entry.sha256, entry.completed, io);
  }
  // 新增文件也不属于经官方归档验证的内容；拒绝签名或逐文件核对期间插入的条目。
  await verifyExtractedTree(directory, createdFiles, createdDirectories, io);
  return { executable: path.join(directory, 'bin', 'codex.exe'), filesVerified: createdFiles.length - 1 };
}
