'use strict';
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const net = require('node:net');

// This proxy is the machine's existing per-application egress gateway.
// Untrusted callers cannot select a proxy, port, resolver, headers or HTTP method.
const PROXY = Object.freeze({ host: '127.0.0.1', port: 7897 });
const DNS_HOST = 'cloudflare-dns.com';
const DNS_IP = '1.1.1.1';
function publicIp(ip) {
  if (net.isIP(ip) === 4) {
    const a = ip.split('.').map(Number);
    return !(a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && (a[1] === 168 || (a[1] === 0 && a[2] === 0) || (a[1] === 0 && a[2] === 2) || (a[1] === 88 && a[2] === 99))) ||
      (a[0] === 198 && (a[1] === 18 || a[1] === 19 || (a[1] === 51 && a[2] === 100))) ||
      (a[0] === 203 && a[1] === 0 && a[2] === 113));
  }
  if (net.isIP(ip) === 6) {
    if (ip.includes('.')) return false;
    const h = ip.split(':'), a = parseInt(h[0] || '0', 16), b = parseInt(h[1] || '0', 16);
    return a >= 0x2000 && a <= 0x3fff &&
      !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && a !== 0x2002 &&
      !(a === 0x3fff && b < 0x1000);
  }
  return false;
}
function checkedUrl(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) throw new TypeError('网址无效');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('只支持无凭证的公开 HTTPS 网址');
  u.hash = ''; // Fragments select a local page section and never enter an HTTP request.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!publicIp(host)) throw new Error('不允许访问本机、私有或保留地址');
  } else {
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) ||
        /(?:^|\.)(localhost|local|internal|test|invalid|onion|lan)$|(?:^|\.)home\.arpa$/i.test(host)) {
      throw new Error('不允许访问内部或无效主机名');
    }
  }
  return u;
}
function connectTunnel(host, address, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('请求已取消'));
    let socket, settled = false;
    const target = (net.isIP(address) === 6 ? '[' + address + ']' : address) + ':443';
    const request = http.request({ ...PROXY, method: 'CONNECT', path: target, headers: { Host: target } });
    const timer = setTimeout(() => fail(new Error('连接超时')), timeoutMs);
    const abort = () => fail(new Error('请求已取消'));
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    function fail(error) {
      if (settled) return;
      settled = true; done(); request.destroy(); socket?.destroy(); reject(error);
    }
    signal?.addEventListener('abort', abort, { once: true });
    request.once('error', fail);
    request.once('connect', (res, plain, head) => {
      socket = plain;
      if (res.statusCode !== 200) return fail(new Error('代理连接失败：' + res.statusCode));
      if (head.length) plain.unshift(head);
      const secure = tls.connect({ socket: plain, servername: host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      socket = secure;
      secure.once('error', fail);
      secure.once('secureConnect', () => { if (!settled) { settled = true; done(); resolve(secure); } });
    });
    request.end();
  });
}
function rawRequest(url, { address, method = 'GET', headers = {}, body, signal, timeoutMs = 45000, maxBytes = 500000 } = {}) {
  const u = checkedUrl(url);
  if (!publicIp(address)) return Promise.reject(new Error('未验证的远端地址'));
  if (signal?.aborted) return Promise.reject(new Error('请求已取消'));
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
  const controller = new AbortController();
  const abortParent = () => controller.abort();
  signal?.addEventListener('abort', abortParent, { once: true });
  agent.createConnection = (_options, callback) => { connectTunnel(u.hostname, address, controller.signal, Math.min(timeoutMs, 15000)).then(socket => callback(null, socket), callback); };
  return new Promise((resolve, reject) => {
    let done = false;
    const request = https.request(u, { method, agent, headers: { ...headers, connection: 'close', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } });
    const timer = setTimeout(() => finish(new Error('公开请求超时')), timeoutMs);
    const abort = () => finish(new Error('请求已取消'));
    controller.signal.addEventListener('abort', abort, { once: true });
    function finish(error, result) {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abortParent);
      controller.signal.removeEventListener('abort', abort); controller.abort(); request.destroy(); agent.destroy();
      error ? reject(error) : resolve(result);
    }
    request.once('error', finish);
    request.once('response', response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) finish(new Error('公开响应过大')); else chunks.push(chunk); });
      response.once('error', finish);
      response.once('aborted', () => finish(new Error('公开响应被中断')));
      response.once('end', () => {
        const buffer = Buffer.concat(chunks);
        finish(null, { status: response.statusCode, headers: response.headers, bytes: buffer, body: buffer.toString('utf8'), url: u.href });
      });
    });
    request.end(body);
  });
}
async function resolvePublic(host, { signal } = {}) {
  host = host.replace(/^\[|\]$/g, '');
  checkedUrl('https://' + (net.isIP(host) === 6 ? '[' + host + ']' : host) + '/');
  if (net.isIP(host)) return host;
  const response = await rawRequest('https://' + DNS_HOST + '/dns-query?name=' + encodeURIComponent(host) + '&type=A',
    { address: DNS_IP, headers: { accept: 'application/dns-json' }, maxBytes: 50000, timeoutMs: 15000, signal });
  if (response.status !== 200) throw new Error('公开 DNS 查询失败');
  const data = JSON.parse(response.body), ips = (data.Answer || []).filter(item => item.type === 1).map(item => item.data);
  if (data.Status !== 0 || !ips.length || ips.some(ip => !publicIp(ip))) throw new Error('DNS 返回了私有、保留或无效地址');
  return ips[0];
}
// For trusted fixed research integrations only. Do not expose arbitrary options as a model tool.
async function requestPublic(url, options = {}) {
  const u = checkedUrl(url), address = await resolvePublic(u.hostname, options);
  return rawRequest(u, { ...options, address });
}
async function fetchPublic(url, { signal, maxBytes = 20 * 1024 * 1024, redirects = 5 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024 || !Number.isSafeInteger(redirects) || redirects < 0 || redirects > 5) throw new Error('请求限制无效');
  let current = checkedUrl(url);
  for (let n = 0; n <= redirects; n++) {
    const result = await requestPublic(current, { signal, maxBytes, headers: { accept: '*/*', 'accept-encoding': 'identity' } });
    if (![301, 302, 303, 307, 308].includes(result.status)) return result;
    if (!result.headers.location || n === redirects) throw new Error('重定向过多或缺少地址');
    current = checkedUrl(new URL(result.headers.location, current)); // No cross-protocol downgrade or credential forwarding.
  }
  throw new Error('无法获取公开资源');
}
module.exports = { publicIp, checkedUrl, resolvePublic, requestPublic, fetchPublic };

