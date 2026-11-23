// Single-resource URL capabilities. Account credentials stay in cookies/headers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RelayLinks = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const TTL = 60 * 60 * 1000, RENEW = 5 * 60 * 1000;
  function scope(url) {
    if (!['/api/file', '/api/preview', '/api/events'].includes(url.pathname)) return null;
    if (['path', 'raw', 'download', 'cap'].some((k) => url.searchParams.getAll(k).length > 1)) return null;
    const file = url.pathname !== '/api/events';
    const rel = file ? url.searchParams.get('path') : '';
    if (file && (typeof rel !== 'string' || !rel)) return null;
    return [url.pathname, rel, url.searchParams.get('raw') === '1', url.searchParams.get('download') === '1'];
  }
  const message = (uid, exp, access) => JSON.stringify(['relay-url-v1', uid, 'GET', ...access, exp]);
  function expiry(input, origin) {
    try { const cap = JSON.parse(new URL(input, origin).searchParams.get('cap')); return Array.isArray(cap) && Number.isSafeInteger(cap[1]) ? cap[1] : 0; }
    catch { return 0; }
  }
  function create({ origin, token, enabled, now = Date.now, hmac }) {
    const cache = new Map();
    let previousToken = '';
    function sign(input) {
      const url = new URL(input, origin);
      if (url.origin !== origin) return input;
      url.searchParams.delete('rt');
      url.searchParams.delete('cap');
      const access = scope(url), key = token();
      if (key !== previousToken) { cache.clear(); previousToken = key; }
      if (enabled() && key && access) {
        const uid = key.slice(0, key.indexOf('.'));
        if (uid) {
          const id = JSON.stringify(access), time = now();
          let entry = cache.get(id);
          if (!entry || entry.exp <= time + RENEW) {
            const exp = Math.floor(time + TTL);
            entry = { exp, cap: JSON.stringify([uid, exp, hmac(key, message(uid, exp, access))]) };
            cache.set(id, entry);
            if (cache.size > 4096) cache.delete(cache.keys().next().value);
          }
          url.searchParams.set('cap', entry.cap);
        }
      }
      return url.pathname + url.search + url.hash;
    }
    function renewElement(el, attr) {
      const value = el && el.getAttribute && el.getAttribute(attr);
      const exp = value && expiry(value, origin);
      if (!exp || exp > now() + RENEW) return false;
      const next = sign(value);
      if (next === value) return false;
      el.setAttribute(attr, next);
      return true;
    }
    return { sign, renewElement, expiry: (input) => expiry(input, origin) };
  }
  return { TTL, RENEW, scope, message, expiry, create };
});
