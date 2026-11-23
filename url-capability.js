const crypto = require('crypto');
const { TTL, scope, message } = require('./public/scoped-links');

// Only the three GET resource routes can consume a URL capability. It is never
// accepted by the account-login helper or by state/sign/chat/upload endpoints.
module.exports = function capabilityUser(req, url, users, tokenFor, now = Date.now()) {
  if (req.method !== 'GET') return null;
  const access = scope(url);
  if (!access || url.searchParams.getAll('cap').length !== 1) return null;
  let cap;
  try { cap = JSON.parse(url.searchParams.get('cap')); } catch { return null; }
  if (!Array.isArray(cap) || cap.length !== 3) return null;
  const [uid, exp, sig] = cap;
  if (typeof uid !== 'string' || !Number.isSafeInteger(exp) || exp <= now || exp > now + TTL + 60e3
      || typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig)) return null;
  const user = users.get(uid);
  if (!user) return null;
  const expected = crypto.createHmac('sha256', tokenFor(user)).update(message(uid, exp, access)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  req.authVia = 'cap';
  req.authExpiresAt = exp;
  return user;
};
