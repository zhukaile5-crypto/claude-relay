'use strict';
const fs = require('node:fs');
const { executeNode } = require('./executor');
(async () => {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const options = request.options || {};
  if (options.stdinBase64 !== undefined) options.stdin = Buffer.from(options.stdinBase64, 'base64');
  const result = await executeNode(request.context, request.code, options);
  const { stdout, ...rest } = result;
  process.stdout.write(JSON.stringify({ ...rest, stdoutBase64: stdout.toString('base64') }));
})().catch((error) => { process.stderr.write(error.message); process.exitCode = 1; });
