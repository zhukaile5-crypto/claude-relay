// Source-based regression checks only: no production requests or service actions.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const args of [
  ['--test', 'tests/backend-scoped.test.cjs', 'tests/scoped-links.test.cjs', 'tests/signed-links.test.cjs'],
  ['--test', 'tests/backend-reliability.test.cjs', 'tests/maintenance.test.cjs', 'tests/maintenance-interruption.test.cjs', 'tests/pinned-programs.test.cjs'],
  ['--test', 'tests/isolation-services.test.cjs', 'tests/workspace-io.test.cjs', 'tests/server-isolation.test.cjs',
    'tests/isolation-cache.test.cjs', 'tests/isolation-readiness.test.cjs', 'tests/isolation-model-config.test.cjs', 'tests/isolation-mcp-paths.test.cjs', 'tests/startup-transcripts.test.cjs'],
  ['--test', 'tests/maintenance-deploy.test.cjs', 'tests/maintenance-inspect.test.cjs', 'tests/maintenance-deploy-entry.test.cjs'],
  ['--test', 'tests/maintenance-policy.test.cjs', 'tests/maintenance-cadence.test.cjs'],
  ['--test', 'tests/maintenance-repair.test.cjs'],
  ['--test', 'tests/maintenance-runtime.test.cjs', 'tests/runtime-health.test.cjs', 'tests/maintenance-runtime-entry.test.cjs', 'tests/maintenance-dispatch.test.cjs'],
  ['--test', 'tests/maintenance-candidate.test.cjs', 'tests/maintenance-candidate-entry.test.cjs'],
  ['--test', 'tests/maintenance-acceptance.test.cjs', 'tests/maintenance-acceptance-flow.test.cjs', 'tests/maintenance-host-state.test.cjs'],
  ['--test', 'tests/codex-fingerprints.test.cjs', 'tests/maintenance-refresh-plan.test.cjs', 'tests/maintenance-program-boundary.test.cjs'],
  ['--test', 'tests/maintenance-download.test.cjs', 'tests/maintenance-acquisition.test.cjs', 'tests/maintenance-acquisition-entry.test.cjs'],
  ['--test', 'tests/maintenance-notify.test.cjs', 'tests/maintenance-mail-config.test.cjs'],
  ['--test', 'tests/maintenance-notice.test.cjs'],
  ['--test', 'tests/maintenance-drain.test.cjs', 'tests/maintenance-drain-client.test.cjs', 'tests/maintenance-drain-server.test.cjs', 'tests/maintenance-drain-entry.test.cjs'],
  ['--test', 'tests/maintenance-retention.test.cjs', 'tests/maintenance-receipt-history.test.cjs', 'tests/maintenance-idle.test.cjs', 'tests/maintenance-retention-entry.test.cjs'],
  ['--test', 'tests/maintenance-closure.test.cjs', 'tests/acceptance-stage.test.cjs', 'tests/page-error-text.test.cjs', 'tests/check-isolation-cli.test.cjs', 'tests/conversation-search.test.cjs'],
  ['--test', 'tests/full-acceptance.test.cjs', 'tests/gpt-retirement.test.cjs'],
  ['--test', 'tests/page-shell.test.cjs', 'tests/page-shell-integration.test.cjs'],
  ['--test', 'tests/markdown-cjk-strong.test.cjs'],
  ['--test', 'tests/model-handoff.test.cjs'],
  ['--test', 'tests/gemini.test.cjs'],
  ['--test', 'tests/model-finalization.test.cjs', 'tests/model-finalization-server.test.cjs'],
  ['--test', 'tests/model-instructions.test.cjs', 'tests/model-instructions-server.test.cjs'],
  ['--test', 'tests/model-session-recovery.test.cjs', 'tests/model-session-recovery-server.test.cjs'],
  ['--test', 'tests/model-choice-server.test.cjs', 'tests/model-choice-frontend.test.cjs', 'tests/model-choice-pending.test.cjs'],
  ['--test', 'tests/model-handoff-stats.test.cjs', 'tests/model-handoff-ui.test.cjs'],
  ['--test', 'tests/model-relay-server.test.cjs', 'tests/model-relay-ui.test.cjs', 'tests/speed-and-handoff.test.cjs', 'tests/verses.test.cjs'],
  ['--test', 'tests/linked-folder.test.cjs', 'tests/reply-paths.test.cjs', 'tests/memory-layers.test.cjs'],
  ['--test', 'tests/chat-work-mode.test.cjs'],
  ['--test', 'tests/model-collaboration.test.cjs', 'tests/model-collaboration-server.test.cjs', 'tests/model-collaboration-ui.test.cjs'],
  ['--test', 'tests/model-handoff-probe.test.cjs'],
  ['tests/frontend-regression.cjs'],
  ['tests/frontend-state.test.cjs'],
  ['tests/operations.test.cjs'],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { ...process.env, RELAY_TEST_ROOT: root }, stdio: 'inherit', windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
