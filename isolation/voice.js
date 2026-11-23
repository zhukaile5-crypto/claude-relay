'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const ONLINE_PY = String.raw`
import asyncio,json,re,sys
from pathlib import Path
import edge_tts
request=Path(sys.argv[1])
req=json.loads(request.read_text(encoding='utf-8'))
text=req.get('text');voice=req.get('voice','zh-CN-XiaoxiaoNeural');rate=req.get('rate','+0%')
if not isinstance(text,str) or not 1<=len(text)<=6000:raise ValueError('Invalid text')
if not isinstance(voice,str) or not re.fullmatch(r'[a-z]{2,3}-[A-Z]{2}-(?:[A-Za-z0-9]{1,30}-)?[A-Za-z]{2,50}Neural',voice):raise ValueError('Invalid voice')
if not isinstance(rate,str) or not re.fullmatch(r'[+-]\d{1,3}%',rate) or not -50<=int(rate[:-1])<=100:raise ValueError('Invalid rate')
out=request.parent/'audio.mp3'
asyncio.run(edge_tts.Communicate(text,voice,rate=rate,proxy=None,connect_timeout=10,receive_timeout=20).save(str(out)))
if out.stat().st_size<=1000:raise ValueError('Empty audio')
`;
const OFFLINE_PS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8 | ConvertFrom-Json
if ($request.text -isnot [string] -or $request.text.Length -lt 1 -or $request.text.Length -gt 6000) { throw 'Invalid text' }
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
 try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}
 $outFile = Join-Path (Split-Path -Parent $args[0]) 'audio.wav'
 $s.SetOutputToWaveFile($outFile)
 $s.Speak($request.text)
} finally { $s.Dispose() }
`;
const STT_PY = String.raw`
import json,subprocess,sys
import numpy as np
from faster_whisper import WhisperModel
r=json.load(sys.stdin)
raw=subprocess.run([r['ffmpeg'],'-nostdin','-v','error','-i',r['file'],'-f','s16le','-ac','1','-ar','16000','-'],capture_output=True,check=True,timeout=60,creationflags=0x08000000).stdout
audio=np.frombuffer(raw,np.int16).astype(np.float32)/32768.
model=WhisperModel(r['model'],device='cpu',compute_type='int8',local_files_only=True)
segments,info=model.transcribe(audio,language=r.get('language'),vad_filter=True,beam_size=5,initial_prompt='以下是普通话的句子，使用简体中文和标点符号。')
text=''.join(s.text.strip() for s in segments)
print(json.dumps({'text':text,'language':info.language,'duration':info.duration},ensure_ascii=True))
`;
const STT_NODE = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
if(typeof input.file!=='string'||path.isAbsolute(input.file)||input.file.includes('\0')||input.file.split(/[\\/]/).includes('..'))throw Error('录音路径无效');
const root=path.resolve(process.cwd()),file=path.resolve(root,input.file),relative=path.relative(root,file);
if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('录音不在当前工作区');
const stat=fs.statSync(file);if(!stat.isFile()||stat.size>100*1024*1024)throw Error('录音文件无效或过大');
const request={file,ffmpeg:input.ffmpeg,model:input.model,language:input.language};
const result=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c',input.script],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:110000,maxBuffer:2*1024*1024});
if(result.error||result.status!==0)throw Error('语音识别失败：'+String(result.error?.message||result.stderr).slice(-2000));
process.stdout.write(result.stdout);
`;
const ENCODE_NODE = String.raw`
const fs=require('node:fs'),cp=require('node:child_process');
const audio=fs.readFileSync(0);if(audio.length>20*1024*1024)throw Error('音频过大');
const result=cp.spawnSync(input.ffmpeg,['-nostdin','-v','error','-i','pipe:0','-f','mp3','-b:a','96k','pipe:1'],{input:audio,windowsHide:true,timeout:45000,maxBuffer:20*1024*1024});
if(result.error||result.status!==0)throw Error('音频编码失败：'+String(result.error?.message||result.stderr).slice(-1500));
process.stdout.write(result.stdout);
`;

function validateSpeech(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['text', 'voice', 'rate'].includes(key))) throw new Error('朗读参数无效');
  const { text, voice = 'zh-CN-XiaoxiaoNeural', rate = '+0%' } = args;
  if (typeof text !== 'string' || !text.length || text.length > 6000 || text.includes('\0')) throw new Error('朗读文字无效');
  if (typeof voice !== 'string' || !/^[a-z]{2,3}-[A-Z]{2}-(?:[A-Za-z0-9]{1,30}-)?[A-Za-z]{2,50}Neural$/.test(voice)) throw new Error('音色无效');
  if (typeof rate !== 'string' || !/^[-+]\d{1,3}%$/.test(rate) || parseInt(rate) < -50 || parseInt(rate) > 100) throw new Error('语速无效');
  return { text, voice, rate };
}
function validateRelativeFile(file) {
  if (typeof file !== 'string' || !file || file.length > 2048 || path.win32.isAbsolute(file) || file.includes('\0') || file.split(/[\\/]/).includes('..') || file.includes(':')) throw new Error('录音路径必须位于当前工作区');
}
function createVoiceService({ executeNode, desktopHost, privateRoot, offlineProfile }) {
  if (typeof executeNode !== 'function' || !path.isAbsolute(desktopHost) || !path.isAbsolute(privateRoot)) throw new Error('可信语音配置无效');
  const profileKeys = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  if (offlineProfile && (typeof offlineProfile !== 'object' || Array.isArray(offlineProfile) || Object.keys(offlineProfile).some(key => !profileKeys.includes(key)) || profileKeys.some(key => typeof offlineProfile[key] !== 'string' || !path.isAbsolute(offlineProfile[key])))) throw new Error('可信离线语音环境无效');
  fs.mkdirSync(privateRoot, { recursive: true });
  const trustedRoot = fs.realpathSync(privateRoot);
  const originalProfile = Object.fromEntries(profileKeys.map(key => [key, offlineProfile?.[key] || process.env[key]]));
  function systemEnvironment(python, tmp) {
    return { SystemDrive: process.env.SystemDrive || 'C:', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      PATH: path.dirname(python) + ';C:\\Windows\\System32;C:\\Windows', TEMP: tmp, TMP: tmp, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  }
  async function fixedSynthesis(context, input, offline, signal) {
    if (signal?.aborted) throw new Error('朗读已取消');
    const python = context.runtime.python;
    if (typeof python !== 'string' || !path.isAbsolute(python)) throw new Error('可信 Python 路径无效');
    const root = fs.mkdtempSync(path.join(trustedRoot, 'tts-'));
    const profile = path.join(root, 'profile'), tmp = path.join(root, 'tmp');
    fs.mkdirSync(profile); fs.mkdirSync(tmp);
    const request = path.join(root, 'input.json'), script = path.join(root, offline ? 'offline.ps1' : 'online.py');
    fs.writeFileSync(request, JSON.stringify(input), 'utf8');
    fs.writeFileSync(script, offline ? OFFLINE_PS : ONLINE_PY, 'utf8');
    const base = systemEnvironment(python, tmp);
    const env = { ...base, ...(offline ? originalProfile : { USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile, HOME: profile }) };
    // Original profile locations are used only by this fixed offline SAPI process,
    // which has no network operation or model-supplied command/path.
    const config = { root, desktop: 'RelayPrivate_TTS_' + crypto.randomBytes(16).toString('hex'),
      exe: offline ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : python,
      args: offline ? ['-NoProfile', '-NonInteractive', '-File', script, request] : ['-X', 'utf8', '-I', '-S', script, request],
      cwd: root, env, timeoutMs: offline ? 30000 : 45000, stdio: false };
    const launch = path.join(root, 'launch.json'); fs.writeFileSync(launch, JSON.stringify(config), 'utf8');
    let child, abort, timer;
    try {
      const code = await new Promise((resolve, reject) => {
        child = cp.spawn(desktopHost, [launch], { cwd: root, env: base, windowsHide: true, stdio: 'ignore' });
        abort = () => child.kill();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        timer = setTimeout(abort, config.timeoutMs + 5000);
        child.once('error', reject); child.once('exit', resolve);
      });
      if (signal?.aborted) throw new Error('朗读已取消');
      const proof = JSON.parse(fs.readFileSync(path.join(root, 'launcher-result.json'), 'utf8'));
      if (code !== 0 || proof.exit !== 0 || proof.privateDesktop !== config.desktop) throw new Error(offline ? '离线语音暂不可用' : '在线语音暂不可用');
      const format = offline ? 'wav' : 'mp3', file = path.join(root, 'audio.' + format), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 1000 || stat.size > 20 * 1024 * 1024) throw new Error('语音输出无效');
      const audio = fs.readFileSync(file);
      if (offline && audio.subarray(0, 4).toString() !== 'RIFF') throw new Error('离线音频格式无效');
      return { audio, format, source: offline ? 'windows-sapi' : 'edge-tts' };
    } finally {
      clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort);
      // Only a broker-created directory under this fixed private root is removed.
      const resolved = fs.realpathSync(root);
      if (path.dirname(resolved).toLowerCase() !== trustedRoot.toLowerCase()) throw new Error('语音临时目录异常');
      // 取消后被结束的进程可能还占着目录；等它退出再删，删不掉也不能盖掉原来的结果或取消提示。
      for (let attempt = 0; ; attempt++) {
        try { fs.rmSync(root, { recursive: true, force: true }); break; }
        catch { if (attempt >= 50) { console.log(' [语音] 临时目录未能清理'); break; } await new Promise(resolve => setTimeout(resolve, 100)); }
      }
    }
  }
  async function synthesize(context, args, { signal, forceOffline = false } = {}) {
    const input = validateSpeech(args);
    let output;
    if (forceOffline) output = await fixedSynthesis(context, input, true, signal);
    else {
      try { output = await fixedSynthesis(context, input, false, signal); }
      catch (error) { if (signal?.aborted) throw error; output = await fixedSynthesis(context, input, true, signal); output.onlineUnavailable = true; }
    }
    if (output.format === 'wav') {
      const result = await executeNode(context, ENCODE_NODE, { input: { ffmpeg: context.runtime.ffmpeg }, stdin: output.audio, signal, timeoutMs: 50000, maxOutputBytes: 20 * 1024 * 1024 });
      if (result.exitCode !== 0 || result.cancelled) throw new Error('离线语音编码失败');
      output.audio = result.stdout; output.format = 'mp3';
    }
    return { ...output, contentType: 'audio/mpeg' };
  }
  async function transcribe(context, args, { signal } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['file', 'language'].includes(key))) throw new Error('录音参数无效');
    const { file, language } = args;
    validateRelativeFile(file);
    if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language))) throw new Error('录音语言无效');
    const result = await executeNode(context, STT_NODE, { input: { file, language, python: context.runtime.python, ffmpeg: context.runtime.ffmpeg, model: context.runtime.whisperModel, script: STT_PY }, signal, timeoutMs: 120000, maxOutputBytes: 2 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.cancelled) throw new Error('语音识别失败：' + String(result.stderr || '').slice(-1500));
    const value = JSON.parse(result.stdout.toString('utf8'));
    if (typeof value.text !== 'string' || value.text.length > 200000) throw new Error('语音识别结果无效');
    return value;
  }
  return { synthesize, transcribe };
}
module.exports = { createVoiceService, validateSpeech, validateRelativeFile };

