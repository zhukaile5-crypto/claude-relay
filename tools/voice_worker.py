"""常驻的语音小助手进程：按行读 JSON 请求，按行回 JSON 结果。

{"id": 1, "op": "stt", "path": "录音.webm"}                  -> {"id": 1, "text": "识别出的文字"}
{"id": 2, "op": "tts", "text": "要朗读的文字", "out": "x.mp3", "voice": "zh-CN-XiaoxiaoNeural"} -> {"id": 2, "ok": true}
语音识别模型只在第一次用到时加载，之后常驻内存，所以后续识别很快。
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys

import numpy as np

sys.stdout.reconfigure(encoding='utf-8')
_model = None


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        _model = WhisperModel('small', device='cpu', compute_type='int8')
    return _model


def load_audio(path):
    ff = shutil.which('ffmpeg')
    if not ff:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    raw = subprocess.run([ff, '-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def stt(path):
    segs, info = model().transcribe(load_audio(path), vad_filter=True, beam_size=5,
                                    initial_prompt='以下是普通话的句子，使用简体中文和标点符号。')
    return ''.join(s.text.strip() for s in segs)


def tts(text, out, voice):
    """优先用微软在线神经语音（自然）；网络不稳时重试，仍失败就用 Windows 自带的离线语音。"""
    import time
    import edge_tts
    for attempt in range(3):
        try:
            asyncio.run(edge_tts.Communicate(text, voice or 'zh-CN-XiaoxiaoNeural').save(out))
            if os.path.getsize(out) > 1000:
                return
        except Exception:
            time.sleep(0.8 * (attempt + 1))
    offline_tts(text, out)


def offline_tts(text, out):
    import tempfile
    tmp = tempfile.mkdtemp()
    txt, wav = os.path.join(tmp, 't.txt'), os.path.join(tmp, 'a.wav')
    with open(txt, 'w', encoding='utf-8') as f:
        f.write(text)
    ps = ("Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
          "try{$s.SelectVoice('Microsoft Huihui Desktop')}catch{};"
          f"$s.SetOutputToWaveFile('{wav}');$s.Speak([IO.File]::ReadAllText('{txt}'));$s.Dispose()")
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, check=True)
    ff = shutil.which('ffmpeg')
    subprocess.run([ff, '-v', 'error', '-y', '-i', wav, '-b:a', '96k', out], check=True)
    shutil.rmtree(tmp, ignore_errors=True)


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        res = {'id': req.get('id')}
        try:
            if req['op'] == 'stt':
                res['text'] = stt(req['path'])
            elif req['op'] == 'tts':
                tts(req['text'], req['out'], req.get('voice'))
                res['ok'] = True
            elif req['op'] == 'ping':
                model(); res['ok'] = True
        except Exception as e:
            res['error'] = str(e)
        print(json.dumps(res, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
