'use strict';
// uiDesktopDeny：两个账号的任务同时运行，各自只应在自己的私有桌面上，打不开交互窗口站、默认桌面和对方桌面。
// 只调用打开类接口，不读写剪贴板、不建窗口，不会打扰正在使用电脑的人。
const fs = require('node:fs'), path = require('node:path');
const { begin, finish, cleanupOk, sleep } = require('./common.cjs');
const run = begin('desktop'), { result, executor, users } = run;
const PROBE = String.raw`
import ctypes,json,pathlib,sys,time
from ctypes import wintypes as w
u=ctypes.WinDLL('user32',use_last_error=True);k=ctypes.WinDLL('kernel32')
for fn,res,args in [(u.GetThreadDesktop,w.HANDLE,[w.DWORD]),(u.GetProcessWindowStation,w.HANDLE,[]),(u.GetUserObjectInformationW,w.BOOL,[w.HANDLE,ctypes.c_int,w.LPVOID,w.DWORD,ctypes.POINTER(w.DWORD)]),(u.OpenWindowStationW,w.HANDLE,[w.LPCWSTR,w.BOOL,w.DWORD]),(u.OpenDesktopW,w.HANDLE,[w.LPCWSTR,w.DWORD,w.BOOL,w.DWORD]),(u.CloseWindowStation,w.BOOL,[w.HANDLE]),(u.CloseDesktop,w.BOOL,[w.HANDLE])]:
 fn.restype=res;fn.argtypes=args
def name(h):
 b=ctypes.create_unicode_buffer(256);n=w.DWORD();u.GetUserObjectInformationW(h,2,b,ctypes.sizeof(b),ctypes.byref(n));return b.value
def opened(fn,*a):
 ctypes.set_last_error(0);h=fn(*a);e=ctypes.get_last_error()
 return h,e
own=name(u.GetThreadDesktop(k.GetCurrentThreadId()));station=name(u.GetProcessWindowStation())
pathlib.Path('desktop-name.txt').write_text(own,encoding='utf-8')
peer=None
for _ in range(300):
 p=pathlib.Path('peer-name.txt')
 if p.exists() and p.read_text(encoding='utf-8'):peer=p.read_text(encoding='utf-8');break
 time.sleep(.1)
out={'own':own,'station':station,'peer':peer}
h,e=opened(u.OpenWindowStationW,'WinSta0',False,0x37F);out['winsta0']={'opened':bool(h),'error':e}
if h:u.CloseWindowStation(h)
h,e=opened(u.OpenDesktopW,'Default',0,False,0x1FF);out['default']={'opened':bool(h),'error':e}
if h:u.CloseDesktop(h)
h,e=opened(u.OpenDesktopW,peer or 'missing',0,False,0x1FF);out['peerDesktop']={'opened':bool(h),'error':e}
if h:u.CloseDesktop(h)
print(json.dumps(out))
`;
const WORKER = "const cp=require('node:child_process');const r=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c',input.script],{encoding:'utf8',windowsHide:true,timeout:60000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status===0?0:1;";
(async () => {
  try {
    const contexts = users.map(user => run.context(user));
    const runs = contexts.map(ctx => executor.executeNode(ctx, WORKER, { input: { python: ctx.runtime.python, script: PROBE }, timeoutMs: 90000, maxOutputBytes: 8000 }));
    const names = [], until = Date.now() + 60000;
    for (const ctx of contexts) {
      const file = path.join(ctx.workspaceRoot, 'desktop-name.txt');
      while (!fs.existsSync(file) || !fs.statSync(file).size) { if (Date.now() > until) throw Error('任务没有报告自己的桌面'); await sleep(100); }
      names.push(fs.readFileSync(file, 'utf8'));
    }
    fs.writeFileSync(path.join(contexts[0].workspaceRoot, 'peer-name.txt'), names[1]);
    fs.writeFileSync(path.join(contexts[1].workspaceRoot, 'peer-name.txt'), names[0]);
    const finished = await Promise.all(runs);
    result.records = finished.map(item => { if (item.exitCode !== 0) throw Error('探针失败：' + (item.error || item.stderr)); return JSON.parse(item.stdout.toString()); });
    result.checks.ownPrivateDesktop = result.records.every(item => /^RelayExec_[a-f0-9]{32}$/.test(item.own));
    result.checks.distinctDesktops = result.records[0].own !== result.records[1].own;
    result.checks.notInteractiveStation = result.records.every(item => item.station.toLowerCase() !== 'winsta0');
    result.checks.interactiveStationDenied = result.records.every(item => !item.winsta0.opened && item.winsta0.error !== 0);
    result.checks.defaultDesktopDenied = result.records.every(item => !item.default.opened);
    result.checks.peerDesktopDenied = result.records.every(item => !item.peerDesktop.opened && item.peer && item.peerDesktop.error !== 0);
    result.checks.cleanupConfirmed = finished.every(item => cleanupOk(item.cleanup));
  } catch (error) { await finish(run, error); return; }
  await finish(run);
})();
