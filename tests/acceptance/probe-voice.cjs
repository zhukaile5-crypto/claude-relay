'use strict';
// 语音：真实在线合成、强制离线合成、本地转写往返、取消清理，以及配音字幕视频。全程不播放声音。
const fs = require('node:fs'), path = require('node:path');
const { createVoiceService } = require('../../isolation/voice');
const { begin, finish, cleanupOk, sleep } = require('./common.cjs');
const run = begin('voice'), { result, iso, executor, users, stage } = run;
const TEXT = '这是完整隔离的语音验证，今天的温度是二十五度。';
const matches = text => /隔离|验证/.test(text) && /25|二十五/.test(text);
const WORKER = "const cp=require('node:child_process');const r=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c',input.script],{input:JSON.stringify(input.request),encoding:'utf8',windowsHide:true,timeout:input.timeout,maxBuffer:8*1024*1024});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status===0?0:1;";
(async () => {
  try {
    const ctx = run.context(users[0]), rt = ctx.runtime, privateRoot = path.join(stage, 'private', 'speech-probe');
    const voice = createVoiceService({ executeNode: executor.executeNode, desktopHost: rt.desktopHost, privateRoot, offlineProfile: rt.ttsOfflineProfile });
    const online = await voice.synthesize(ctx, { text: TEXT });
    result.online = { source: online.source, bytes: online.audio.length, onlineUnavailable: !!online.onlineUnavailable };
    // 在线服务不可用时会自动回退，那不算在线通过。
    result.checks.voiceOnline = online.source === 'edge-tts' && !online.onlineUnavailable && online.audio.length > 1000;
    fs.writeFileSync(path.join(ctx.workspaceRoot, 'online.mp3'), online.audio);
    const heardOnline = await voice.transcribe(ctx, { file: 'online.mp3', language: 'zh' });
    result.online.text = heardOnline.text; result.checks.sttOnline = matches(heardOnline.text);
    const offline = await voice.synthesize(ctx, { text: TEXT }, { forceOffline: true });
    result.offline = { source: offline.source, bytes: offline.audio.length };
    result.checks.voiceOffline = offline.source === 'windows-sapi' && offline.format === 'mp3' && offline.audio.length > 1000;
    fs.writeFileSync(path.join(ctx.workspaceRoot, 'offline.mp3'), offline.audio);
    const heardOffline = await voice.transcribe(ctx, { file: 'offline.mp3', language: 'zh' });
    result.offline.text = heardOffline.text; result.checks.sttOffline = matches(heardOffline.text);
    const abort = new AbortController(); let cancelled = null;
    const pending = voice.synthesize(ctx, { text: TEXT }, { signal: abort.signal, forceOffline: true }).then(() => null, error => error.message);
    await sleep(300); abort.abort(); cancelled = await pending;
    const leftover = fs.readdirSync(privateRoot);
    result.checks.voiceCancel = cancelled === '朗读已取消' && leftover.length === 0;
    result.cancelMessage = cancelled; result.cancelLeftover = leftover.length;
    if (leftover.length) { result.cancelFiles = leftover.flatMap(name => fs.readdirSync(path.join(privateRoot, name))); await sleep(5000); result.cancelLeftoverLater = fs.readdirSync(privateRoot).length; }
    fs.mkdirSync(path.join(ctx.workspaceRoot, 'probe-work'), { recursive: true });
    fs.copyFileSync(path.join(ctx.workspaceRoot, 'online.mp3'), path.join(ctx.workspaceRoot, 'probe-work', 'narration.mp3'));
    const media = await executor.executeNode(ctx, WORKER, { input: { python: rt.python, script: fs.readFileSync(path.join(__dirname, 'runtime-probe.py'), 'utf8'), timeout: 300000,
      request: { role: 'media', runtime: rt.runtimeRoot, audio: 'narration.mp3', ffmpeg: rt.ffmpeg, ffprobe: rt.ffprobe } }, timeoutMs: 330000, maxOutputBytes: 2 * 1024 * 1024 });
    const line = media.stdout.toString().split(/\r?\n/).find(text => text.startsWith('RUNTIME_PROBE_RESULT '));
    if (media.exitCode !== 0 || !line) throw Error('视频探针失败：' + (media.error || String(media.stderr || '').slice(-1500)));
    result.media = JSON.parse(line.slice('RUNTIME_PROBE_RESULT '.length));
    result.checks.media = result.media.checks.video === true && cleanupOk(media.cleanup);
  } catch (error) { await finish(run, error); return; }
  await finish(run);
})();
