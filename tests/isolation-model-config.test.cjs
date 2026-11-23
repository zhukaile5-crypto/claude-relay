'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateCodexBaseConfig } = require('../isolation');
const legacy = 'approval_policy="never"\nsandbox_mode="workspace-write"\nmodel_reasoning_summary="detailed"\n[windows]\nsandbox="unelevated"\n[sandbox_workspace_write]\nnetwork_access=true\n';
test('GPT profile inheritance accepts only empty or the exact known legacy base', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-config-test-'));
  try {
    assert.doesNotThrow(() => validateCodexBaseConfig(home));
    for (const value of ['', '# synthetic comment\n', legacy, '# comment\n' + legacy.replace('"never"', "'never' # harmless comment")]) {
      fs.writeFileSync(path.join(home, 'config.toml'), value);
      assert.doesNotThrow(() => validateCodexBaseConfig(home));
    }
    for (const value of [legacy + '[mcp_servers.untrusted]\ncommand="other"\n', legacy + '[permissions.other.filesystem]\n"*"="write"\n', legacy.replace('unelevated','elevated'), legacy.replace('true','false'), legacy + 'network_access=true\n', 'approval_policy="never"\n', '[windows]\n', legacy + '[hooks]\n', 'x'.repeat(16385)]) {
      fs.writeFileSync(path.join(home, 'config.toml'), value);
      assert.throws(() => validateCodexBaseConfig(home), /Unsupported GPT base configuration/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
