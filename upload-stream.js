'use strict';

const fs = require('node:fs');

// Resolve only after the file descriptor closes, so callers can remove partial
// uploads on Windows on every failure path, including a disconnected request.
function receiveFile(req, file, limit, { createWriteStream = fs.createWriteStream, fd } = {}) {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(file, { flags: 'wx', ...(fd === undefined ? {} : { fd, autoClose: true }) });
    let size = 0, failure = null, finished = false, settled = false;
    const fail = (error) => {
      if (settled || failure) return;
      failure = error;
      req.unpipe(ws);
      ws.destroy();
      if (!req.destroyed) req.resume();
    };
    const aborted = () => fail(Object.assign(new Error('上传已中断'), { code: 'UPLOAD_ABORTED' }));
    const closed = () => { if (!req.complete && !req.readableEnded) aborted(); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) fail(Object.assign(new Error('文件超过大小限制'), { statusCode: 413 }));
    };
    const cleanup = () => {
      req.off('data', data); req.off('aborted', aborted);
      req.off('close', closed); req.off('error', fail);
    };
    ws.on('error', (error) => { failure ||= error; req.unpipe(ws); if (!req.destroyed) req.resume(); });
    ws.on('finish', () => { finished = true; });
    ws.on('close', () => {
      if (settled) return;
      settled = true; cleanup();
      if (failure || !finished) reject(failure || new Error('上传未完成'));
      else resolve(size);
    });
    req.on('data', data); req.on('aborted', aborted);
    req.on('close', closed); req.on('error', fail);
    if (req.aborted || (req.destroyed && !req.readableEnded)) aborted();
    else req.pipe(ws);
  });
}

module.exports = receiveFile;
