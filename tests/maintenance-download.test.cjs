'use strict';
// M10：下载响应、文件系统和发布方签名均为模拟；不运行任何候选或安装器。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.RELAY_TEST_ROOT || path.resolve(__dirname, '..');
const { discover, prepareCandidate, recordAcquisitionResult, STAGING_ROOTS } =
  require(path.join(root, 'tools/maintenance-download.cjs'));
const BASE = 'https://downloads.claude.ai/claude-code-releases';
const VERSION = '2.1.316';
const HASH = body => crypto.createHash('sha256').update(body).digest('hex');
const error = code => Object.assign(new Error(code), { code });

function memoryFs() {
  const nodes = new Map();
  let nextIno = 1;
  function directory(file) {
    nodes.set(file, { kind: 'directory', dev: 1, ino: nextIno++, nlink: 1, mtimeMs: 0, ctimeMs: 0 });
  }
  for (const staging of STAGING_ROOTS) {
    let current = path.parse(staging).root;
    directory(current);
    for (const part of staging.slice(current.length).split(path.sep)) {
      current = path.join(current, part); directory(current);
    }
  }
  function stat(file) {
    const node = nodes.get(file);
    if (!node) throw error('ENOENT');
    return statNode(node);
  }
  function statNode(node) {
    return { dev: node.dev, ino: node.ino, size: node.data?.length || 0, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs, nlink: node.nlink,
      isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'link' };
  }
  return {
    nodes, stat,
    async lstat(file) { return stat(file); },
    async mkdir(file) {
      if (nodes.has(file)) throw error('EEXIST');
      if (!nodes.has(path.dirname(file))) throw error('ENOENT');
      directory(file);
    },
    async readFile(file, encoding) {
      if (!nodes.has(file)) throw error('ENOENT');
      const data = nodes.get(file).data;
      return encoding ? data.toString(encoding) : data;
    },
    async readdir(file) {
      if (!nodes.has(file)) throw error('ENOENT');
      return [...nodes.keys()].filter(item => item !== file && path.dirname(item) === file).map(item => path.basename(item));
    },
    async open(file, flags) {
      if (flags === 'r') {
        const node = nodes.get(file);
        if (!node) throw error('ENOENT');
        let cursor = 0;
        return {
          async read(buffer, offset, count) {
            const bytesRead = Math.min(count, node.data.length - cursor);
            node.data.copy(buffer, offset, cursor, cursor + bytesRead); cursor += bytesRead;
            return { bytesRead };
          }, async stat() { return statNode(node); }, async close() {},
        };
      }
      assert.equal(flags, 'wx');
      if (nodes.has(file)) throw error('EEXIST');
      if (!nodes.has(path.dirname(file))) throw error('ENOENT');
      const node = { kind: 'file', dev: 1, ino: nextIno++, data: Buffer.alloc(0), nlink: 1, mtimeMs: 0, ctimeMs: 0 };
      nodes.set(file, node);
      return {
        async write(value, offset, count) {
          // 故意部分写入，验证实现不会遗漏余下字节。
          const size = Math.min(count, 3);
          node.data = Buffer.concat([node.data, Buffer.from(value).subarray(offset, offset + size)]);
          node.mtimeMs++; node.ctimeMs++;
          return { bytesWritten: size };
        },
        async stat() { return statNode(node); }, async sync() {}, async close() {},
      };
    },
    async unlink(file) { nodes.delete(file); },
    async rmdir(file) {
      if ([...nodes.keys()].some(item => item !== file && path.dirname(item) === file)) throw error('ENOTEMPTY');
      nodes.delete(file);
    },
  };
}
function fixture(over = {}) {
  const binary = Buffer.from('MZ mock native executable, not a runnable program');
  const manifest = { version: VERSION, platforms: {
    'win32-x64': { binary: 'claude.exe', checksum: HASH(binary), size: binary.length },
  } };
  const calls = [], signatures = [], fs = memoryFs();
  const options = {
    fs, platform: 'win32-x64',
    request: async (url, requestOptions) => {
      calls.push({ url, requestOptions });
      if (url === BASE + '/latest') return new Response(VERSION);
      if (url === BASE + '/' + VERSION + '/manifest.json') return new Response(JSON.stringify(manifest));
      if (url === BASE + '/' + VERSION + '/win32-x64/claude.exe') return new Response(binary);
      throw new Error('unexpected public URL');
    },
    signedBy: async (file, signer) => { signatures.push({ file, signer }); return true; },
    ...over,
  };
  const target = path.join(STAGING_ROOTS[0], 'mock-candidate');
  return { binary, manifest, calls, signatures, fs, options, target };
}

test('M10 Claude按实际官方清单结构发现版本与资源，不运行安装器', async () => {
  const f = fixture();
  const result = await discover('Claude', f.options);
  assert.equal(result.status, 'available');
  assert.equal(result.version, VERSION);
  assert.equal(result.download.url, BASE + '/' + VERSION + '/win32-x64/claude.exe');
  assert.equal(result.download.sha256, HASH(f.binary));
  assert.equal(result.download.size, f.binary.length);
  assert.equal(result.provenance.manifestSignature, 'not-verified');
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.requestOptions.method === 'GET' && call.requestOptions.redirect === 'manual'));
  assert.equal(f.signatures.length, 0);
});

test('M10 可选固定版本不读取latest；未知格式/平台明确unsupported且无网络', async () => {
  const f = fixture();
  assert.equal((await discover('claude', { ...f.options, version: VERSION })).status, 'available');
  assert.equal(f.calls.length, 1);
  f.calls.length = 0;
  assert.equal((await discover('unknown', f.options)).status, 'unsupported');
  assert.equal((await discover('claude', { ...f.options, platform: 'linux-x64' })).status, 'unsupported');
  assert.equal((await discover('codex', { ...f.options, platform: 'linux-x64' })).status, 'unsupported');
  assert.equal(f.calls.length, 0);
});

test('M10 拒绝恶意版本、清单版本不符、路径穿越文件名和非法校验值', async () => {
  const f = fixture();
  for (const version of ['../escape', '2.1.316?key=oops', '2.1.316\n../x', {}]) {
    assert.equal((await discover('claude', { ...f.options, version })).status, 'failed');
  }
  assert.equal(f.calls.length, 0);
  for (const patch of [{ binary: '../claude.exe' }, { binary: 'C:\\claude.exe' },
    { checksum: 'bad' }, { size: 0 }, { size: 512 * 1024 * 1024 + 1 }]) {
    const g = fixture();
    Object.assign(g.manifest.platforms['win32-x64'], patch);
    assert.equal((await discover('claude', g.options)).reason, 'invalid-manifest-asset');
  }
  f.manifest.version = '9.9.9';
  assert.equal((await discover('claude', f.options)).reason, 'manifest-version-mismatch');
});

test('M10 重定向、非200、超大元数据和改源响应均拒绝', async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 302, headers: { location: 'https://evil.invalid/binary' } }), 'redirect-not-allowed'],
    [new Response('', { status: 503 }), 'download-http-failed'],
    [new Response('x'.repeat(65)), 'metadata-too-large'],
    [new Response('', { headers: { 'content-length': '99999' } }), 'download-too-large'],
  ]) {
    const f = fixture({ request: async () => response });
    assert.equal((await discover('claude', f.options)).reason, expected);
  }
  const response = new Response(VERSION);
  Object.defineProperty(response, 'url', { value: 'https://evil.invalid/release' });
  const f = fixture({ request: async () => response });
  assert.equal((await discover('claude', f.options)).reason, 'redirect-not-allowed');
});

test('M10 完整接收含部分写入、SHA256和原发布方签名全部通过才返回ready', async () => {
  const f = fixture();
  const result = await prepareCandidate('claude', f.target, f.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.candidateRoot, f.target);
  assert.equal(result.executable, path.join(f.target, 'claude.exe'));
  assert.deepEqual(f.fs.nodes.get(result.executable).data, f.binary);
  assert.deepEqual(f.signatures, [{ file: result.executable, signer: 'Anthropic, PBC' }]);
  assert.equal(result.provenance.sha256Verified, true);
  assert.equal(result.provenance.authenticodeVerified, true);
  assert.equal(result.provenance.manifestSignature, 'not-verified');
});

test('M10 SHA256或长度不符不能进入签名/验收，且只清理自己的候选', async () => {
  for (const mode of ['checksum', 'short', 'long']) {
    const f = fixture(), original = f.options.request;
    f.options.request = async (url, opts) => {
      if (!url.endsWith('/claude.exe')) return original(url, opts);
      const body = mode === 'checksum' ? Buffer.alloc(f.binary.length, 1) :
        mode === 'short' ? f.binary.subarray(0, -1) : Buffer.concat([f.binary, Buffer.from('extra')]);
      return new Response(body);
    };
    const result = await prepareCandidate('claude', f.target, f.options);
    assert.equal(result.status, 'failed');
    assert.equal(f.signatures.length, 0);
    assert.ok(!f.fs.nodes.has(f.target));
    assert.ok(f.fs.nodes.has(STAGING_ROOTS[0]));
  }
});

test('M10 签名拒绝、链接文件或检查期间被更换均拒绝', async () => {
  const a = fixture({ signedBy: async () => false });
  assert.equal((await prepareCandidate('claude', a.target, a.options)).reason, 'signature-mismatch');
  assert.ok(!a.fs.nodes.has(a.target));
  const b = fixture();
  b.options.signedBy = async file => { b.fs.nodes.get(file).mtimeMs++; return true; };
  assert.equal((await prepareCandidate('claude', b.target, b.options)).reason, 'candidate-changed-during-check');
  const c = fixture();
  c.options.signedBy = async file => { c.fs.nodes.get(file).nlink = 2; return true; };
  assert.equal((await prepareCandidate('claude', c.target, c.options)).reason, 'candidate-changed-during-check');
  // 多硬链接身份异常的文件保留，不冒险删除其他路径共用的文件。
  assert.ok(c.fs.nodes.has(path.join(c.target, 'claude.exe')));
});

test('M10 Claude 签名期间同长度改写并恢复文件时间仍必须拒绝', async () => {
  const f = fixture();
  f.options.signedBy = async file => {
    const node = f.fs.nodes.get(file);
    node.data = Buffer.from(node.data); node.data[0] ^= 1;
    // 故意保持 inode、长度和所有时间字段，必须靠最终内容摘要发现。
    return true;
  };
  const result = await prepareCandidate('claude', f.target, f.options);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'candidate-changed-during-check');
});

test('M10 不能覆盖既有目录或写到机主工具、正式副本、祖先及越界路径', async () => {
  const f = fixture();
  for (const target of [STAGING_ROOTS[0], path.join(STAGING_ROOTS[0], '..', 'escape'),
    path.join(root, 'server.js'), 'C:\\Users\\owner\\.local\\claude.exe', 'relative']) {
    assert.equal((await prepareCandidate('claude', target, f.options)).status, 'failed');
  }
  await f.fs.mkdir(f.target);
  assert.equal((await prepareCandidate('claude', f.target, f.options)).reason, 'destination-exists');
  assert.equal(f.calls.length, 0);
  assert.ok(Object.isFrozen(STAGING_ROOTS));
});

test('M10 拒绝目录连接、Windows特殊名称和ADS，不追随到其他目录', async () => {
  const f = fixture();
  f.fs.nodes.get(STAGING_ROOTS[0]).kind = 'link';
  assert.equal((await prepareCandidate('claude', f.target, f.options)).reason, 'linked-destination');
  assert.equal(f.calls.length, 0);
  const g = fixture();
  for (const name of ['NUL', 'folder.', 'a:b']) {
    // 特殊名称作为父目录会在写入前拒绝。
    assert.equal((await prepareCandidate('claude', path.join(STAGING_ROOTS[0], name, 'candidate'), g.options)).reason, 'unsafe-destination');
  }
  assert.equal(g.calls.length, 0);
});

test('M10 无法写入时不执行签名；错误结果不带任意异常文本', async () => {
  const f = fixture();
  f.options.fs = { ...f.fs, open: async () => { throw new Error('private filesystem detail'); } };
  const result = await prepareCandidate('claude', f.target, f.options);
  assert.equal(result.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('private filesystem detail'));
  assert.equal(f.signatures.length, 0);
});

test('M10 获取失败与版本不可读共用3次阈值，恢复后可开始新一轮', () => {
  let state = recordAcquisitionResult({}, { ok: false, reason: 'download-failed' });
  assert.equal(state.notify, false);
  state = recordAcquisitionResult(state, { ok: false, reason: 'version-unreadable' });
  assert.equal(state.notify, false);
  state = recordAcquisitionResult(state, { ok: false, reason: 'download-failed' });
  assert.equal(state.notify, true);
  assert.equal(state.consecutiveFailures, 3);
  state = recordAcquisitionResult(state, { ok: false });
  assert.equal(state.notify, false);
  assert.equal(state.consecutiveFailures, 4);
  assert.deepEqual(recordAcquisitionResult(state, { ok: true }),
    { consecutiveFailures: 0, notified: false, notify: false, reason: null });
});

const { promisify } = require('node:util');
const zlib = require('node:zlib');
const gzip = promisify(zlib.gzip);
const CODEX = 'https://releases.openai.com/codex';
const CODEX_VERSION = '0.166.0';
const PACKAGE = 'codex-package-x86_64-pc-windows-msvc.tar.gz';

function tarEntry(entry) {
  const name = entry.name, data = Buffer.from(entry.data || ''), header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000600\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write((entry.size ?? data.length).toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = (entry.type || '0').charCodeAt(0);
  if (entry.link) header.write(entry.link, 157, 100, 'utf8');
  header.write(entry.gnu ? 'ustar ' : 'ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
async function codexFixture(over = {}) {
  const f = fixture(), metadata = {
    layoutVersion: 1, version: CODEX_VERSION, target: 'x86_64-pc-windows-msvc', variant: 'codex',
    entrypoint: 'bin/codex.exe', execServer: 'bin/codex-exec-server.exe',
    resourcesDir: 'codex-resources', pathDir: 'codex-path', ...(over.metadata || {}),
  };
  const required = ['bin/codex.exe', 'bin/codex-code-mode-host.exe', 'bin/codex-exec-server.exe',
    'codex-path/rg.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'];
  const entries = over.entries || [
    { name: './', type: '5' },
    { name: 'bin/', type: '5' }, { name: 'codex-path/', type: '5' }, { name: 'codex-resources/', type: '5' },
    { name: 'codex-package.json', data: JSON.stringify(metadata) },
    ...required.filter(name => name !== over.omit).map(name => ({ name, data: 'MZ synthetic ' + name, gnu: true })),
    ...(over.extra || []),
  ];
  const archive = await gzip(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]));
  const digest = HASH(archive), sumsText = digest + '  ' + PACKAGE + '\n';
  const releaseBase = CODEX + '/releases/' + CODEX_VERSION;
  const release = { tag_name: 'rust-v' + CODEX_VERSION, assets: [
    { name: PACKAGE, digest: 'sha256:' + digest, browser_download_url: releaseBase + '/' + PACKAGE },
    { name: 'codex-package_SHA256SUMS', digest: 'sha256:' + HASH(sumsText),
      browser_download_url: releaseBase + '/codex-package_SHA256SUMS' },
  ] };
  f.options.request = async (url, requestOptions) => {
    f.calls.push({ url, requestOptions });
    if (url === CODEX + '/channels/latest') return new Response(JSON.stringify({ tag_name: 'rust-v' + CODEX_VERSION }));
    if (url === releaseBase + '/release.json') return new Response(JSON.stringify(release));
    if (url === releaseBase + '/codex-package_SHA256SUMS') return new Response(sumsText);
    if (url === releaseBase + '/' + PACKAGE) return new Response(archive);
    throw new Error('unexpected official resource');
  };
  return { ...f, metadata, required, release, archive, sumsText, releaseBase };
}

test('M10 Codex核对官方release元数据、清单本身摘要和归档双重摘要', async () => {
  const f = await codexFixture();
  const result = await discover('Codex', f.options);
  assert.equal(result.status, 'available');
  assert.equal(result.version, CODEX_VERSION);
  assert.equal(result.download.sha256, HASH(f.archive));
  assert.equal(result.download.size, null);
  assert.equal(result.download.maxBytes, 512 * 1024 * 1024);
  assert.equal(result.provenance.checksumsSha256Verified, true);
  assert.equal(f.calls.length, 3);
  assert.equal(f.signatures.length, 0);
});

test('M10 Codex拒绝改源URL、重复资产、坏清单摘要和归档摘要不一致', async () => {
  for (const change of [
    f => { f.release.assets[0].browser_download_url = 'https://evil.invalid/' + PACKAGE; },
    f => { f.release.assets.push({ ...f.release.assets[0] }); },
    f => { f.release.assets[1].digest = 'sha256:' + '0'.repeat(64); },
    f => { f.release.assets[0].digest = 'sha256:' + '0'.repeat(64); },
  ]) {
    const f = await codexFixture(); change(f);
    assert.equal((await discover('codex', f.options)).status, 'failed');
    assert.equal(f.signatures.length, 0);
    assert.ok(!f.calls.some(call => call.url.endsWith('.tar.gz')));
  }
});

test('M10 Codex流式展开完整目录并验证四个原有发布方签名，不仅复制exe', async () => {
  const f = await codexFixture();
  const result = await prepareCandidate('codex', f.target, f.options);
  assert.equal(result.status, 'ready');
  assert.equal(result.executable, path.join(f.target, 'bin', 'codex.exe'));
  assert.equal(result.filesVerified, 7);
  for (const relative of f.required) assert.ok(f.fs.nodes.has(path.join(f.target, relative)));
  assert.ok(!f.fs.nodes.has(path.join(f.target, '.codex-package.tar.gz')));
  assert.equal(f.signatures.length, 4);
  assert.ok(f.signatures.every(item => item.signer === 'OpenAI OpCo, LLC'));
});

test('M10 Codex缺辅助程序、错误包版本或入口路径均不能准备成功', async () => {
  for (const change of [
    { omit: 'bin/codex-code-mode-host.exe' },
    { omit: 'codex-resources/codex-windows-sandbox-setup.exe' },
    { metadata: { version: '0.1.0' } },
    { metadata: { entrypoint: '../codex.exe' } },
    { metadata: { target: 'aarch64-pc-windows-msvc' } },
  ]) {
    const f = await codexFixture(change);
    assert.equal((await prepareCandidate('codex', f.target, f.options)).status, 'failed');
    assert.equal(f.signatures.length, 0);
  }
});

test('M10 tar路径穿越、绝对路径、ADS、符号/硬链接及PAX未知类型一律拒绝', async () => {
  for (const entry of [
    { name: '../outside.exe' }, { name: '/outside.exe' }, { name: 'a:b' },
    { name: 'bin\\outside.exe' }, { name: 'NUL' },
    { name: 'sym', type: '2', link: '../outside' }, { name: 'hard', type: '1', link: 'bin/codex.exe' },
    { name: 'PaxHeader', type: 'x', data: 'arbitrary' },
  ]) {
    const f = await codexFixture({ extra: [entry] });
    assert.equal((await prepareCandidate('codex', f.target, f.options)).status, 'failed');
    assert.equal(f.signatures.length, 0);
    assert.ok([...f.fs.nodes.keys()].every(file => !file.endsWith('outside.exe')));
  }
});

// 与官方 0.167.0 包相同：每个条目前一个只含 mtime 的 PAX 扩展头。
function paxRecord(key, value) {
  const body = ' ' + key + '=' + value + '\n';
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return length + body;
}
const pax = (...records) => ({ name: '././@PaxHeader', type: 'x', data: records.join('') });

test('M10 Codex接受只含时间字段的PAX扩展头（官方0.167.0格式）', async () => {
  const base = await codexFixture();
  const plain = [{ name: 'codex-package.json', data: JSON.stringify(base.metadata) },
    ...base.required.map(name => ({ name, data: 'MZ synthetic ' + name }))];
  const f = await codexFixture({ entries: plain.flatMap(entry => [pax(paxRecord('mtime', '1793924980.0841649')), entry]) });
  const result = await prepareCandidate('codex', f.target, f.options);
  assert.equal(result.status, 'ready');
  assert.equal(f.signatures.length, 4);
  assert.ok([...f.fs.nodes.keys()].every(file => !/PaxHeader/.test(file)));
});

test('M10 PAX扩展头改路径、链接、大小、属主或格式不合规时拒绝', async () => {
  for (const extra of [
    [pax(paxRecord('path', 'bin/codex.exe')), { name: 'x.txt', data: 'a' }],
    [pax(paxRecord('linkpath', '../outside')), { name: 'y.txt', data: 'a' }],
    [pax(paxRecord('size', '999')), { name: 'z.txt', data: 'a' }],
    [pax(paxRecord('uid', '0')), { name: 'u.txt', data: 'a' }],
    [pax(paxRecord('mtime', 'not-a-number')), { name: 'm.txt', data: 'a' }],
    [pax('99 mtime=1\n'), { name: 'n.txt', data: 'a' }],
    [pax(paxRecord('mtime', '1')), pax(paxRecord('mtime', '2')), { name: 'w.txt', data: 'a' }],
    [{ name: 'GlobalHeader', type: 'g', data: paxRecord('mtime', '1') }],
    [pax(paxRecord('mtime', '1'))],
  ]) {
    const f = await codexFixture({ extra });
    assert.equal((await prepareCandidate('codex', f.target, f.options)).status, 'failed');
    assert.equal(f.signatures.length, 0);
  }
});

test('M10 tar大小写重名、超大条目和归档摘要损坏均拒绝', async () => {
  for (const entry of [
    { name: 'BIN/CODEX.EXE', data: 'duplicate' },
    { name: 'bomb', size: 512 * 1024 * 1024 + 1 },
  ]) {
    const f = await codexFixture({ extra: [entry] });
    assert.equal((await prepareCandidate('codex', f.target, f.options)).status, 'failed');
    assert.equal(f.signatures.length, 0);
  }
  const f = await codexFixture(), original = f.options.request;
  f.options.request = (url, options) => url.endsWith('.tar.gz')
    ? Promise.resolve(new Response(Buffer.from('corrupt archive'))) : original(url, options);
  assert.equal((await prepareCandidate('codex', f.target, f.options)).reason, 'checksum-mismatch');
  assert.equal(f.signatures.length, 0);
});

test('M10 Codex辅助程序发布方签名失败时拒绝整个候选', async () => {
  const f = await codexFixture();
  f.options.signedBy = async file => !file.endsWith('codex-windows-sandbox-setup.exe');
  assert.equal((await prepareCandidate('codex', f.target, f.options)).reason, 'signature-mismatch');
  assert.ok(!f.fs.nodes.has(path.join(f.target, 'bin', 'codex.exe')));
});

test('M10 Codex 签名期间改写未签名文档、JSON 或 DLL 不能靠原时间混过最终核对', async () => {
  for (const relative of ['manual.md', 'extra.json', 'runtime.dll']) {
    const f = await codexFixture({ extra: [{ name: relative, data: 'original' }] });
    f.options.signedBy = async () => { f.fs.nodes.get(path.join(f.target, relative)).data = Buffer.from('tampered'); return true; };
    const result = await prepareCandidate('codex', f.target, f.options);
    assert.equal(result.status, 'failed', relative);
    assert.equal(result.reason, 'candidate-changed-during-check', relative);
  }
});

test('M10 已下载归档在解压前被同长度改写时仍要重新核对官方摘要', async () => {
  const f = await codexFixture(), open = f.fs.open;
  f.fs.open = async (file, flags) => {
    if (flags === 'r' && file.endsWith('.codex-package.tar.gz')) {
      const node = f.fs.nodes.get(file); node.data = Buffer.from(node.data);
      node.data[4] ^= 1; // 只改 gzip 头的时间字节，解压内容仍然有效。
    }
    return open(file, flags);
  };
  const result = await prepareCandidate('codex', f.target, f.options);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'candidate-changed-during-check');
  assert.equal(f.signatures.length, 0);
});

test('M10 签名期间插入归档以外文件必须拒绝，且不能删除这个未知文件', async () => {
  const f = await codexFixture(), unknown = path.join(f.target, 'injected.dll');
  f.options.signedBy = async () => {
    f.fs.nodes.set(unknown, { kind: 'file', dev: 1, ino: 999999, data: Buffer.from('未知写入'), nlink: 1, mtimeMs: 0, ctimeMs: 0 });
    return true;
  };
  const result = await prepareCandidate('codex', f.target, f.options);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'candidate-changed-during-check');
  assert.equal(f.fs.nodes.get(unknown).data.toString(), '未知写入');
});

test('M10 内容哈希读取期间替换 inode 或改写后恢复 mtime 必须拒绝', async () => {
  for (const mode of ['inode', 'ctime']) {
    const f = fixture(), open = f.fs.open;
    f.fs.open = async (file, flags) => {
      const handle = await open(file, flags);
      if (flags !== 'r') return handle;
      const read = handle.read; let changed = false;
      handle.read = async (...args) => {
        const result = await read(...args);
        if (!changed && result.bytesRead) {
          changed = true;
          const node = f.fs.nodes.get(file);
          if (mode === 'inode') f.fs.nodes.set(file, { ...node, ino: node.ino + 10000 });
          else node.ctimeMs++;
        }
        return result;
      };
      return handle;
    };
    const result = await prepareCandidate('claude', f.target, f.options);
    assert.equal(result.status, 'failed', mode);
    assert.equal(result.reason, 'candidate-changed-during-check', mode);
  }
});

test('M10 Codex实际发布元数据可超过64KiB，独立1MiB上限仍会阻止过大响应', async () => {
  const f = await codexFixture();
  f.release.padding = 'x'.repeat(110000);
  const original = f.options.request;
  f.options.request = (url, opts) => url.endsWith('/channels/latest')
    ? Promise.resolve(new Response(JSON.stringify({ tag_name: 'rust-v' + CODEX_VERSION, padding: 'x'.repeat(110000) })))
    : original(url, opts);
  assert.equal((await discover('codex', f.options)).status, 'available');
  const huge = await codexFixture({ });
  huge.options.request = async () => new Response('', { headers: { 'content-length': String(1024 * 1024 + 1) } });
  assert.equal((await discover('codex', huge.options)).reason, 'download-too-large');
});

test('M10 下载失败按身份倒序清理新建空目录，不触碰已存在的暂存根', async () => {
  const f = await codexFixture({ extra: [{ name: 'new/nested/file', data: 'sample' },
    { name: 'bad-link', type: '2', link: '../elsewhere' }] });
  assert.equal((await prepareCandidate('codex', f.target, f.options)).status, 'failed');
  assert.ok(!f.fs.nodes.has(f.target));
  assert.ok(f.fs.nodes.has(STAGING_ROOTS[0]));
});

test('M10 候选根名称本身也拒绝Windows保留名、尾随点和ADS', async () => {
  const f = fixture();
  for (const name of ['NUL', 'folder.', 'a:b'])
    assert.equal((await prepareCandidate('claude', path.join(STAGING_ROOTS[0], name), f.options)).status, 'failed');
  assert.equal(f.calls.length, 0);
});
