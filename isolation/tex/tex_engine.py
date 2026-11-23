"""Fixed in-process TeX ABI adapter, callable only inside the verified worker.
Original engine DLLs remain unchanged. The process container enforces access.
"""
from pathlib import Path as _GuardPath
import hashlib as _GuardHash
import importlib.util as _GuardImport
_guard_path=_GuardPath(r'C:\ClaudeRelayRuntime\tools\tex\environment_guard.py')
if _GuardHash.sha256(_guard_path.read_bytes()).hexdigest()!='8c6d2d7e656f17c53cb8e31cedb0446faeef76ff63b6d82349c78206608fb598':
 raise RuntimeError('Unexpected environment guard build')
_guard_spec=_GuardImport.spec_from_file_location('_relay_tex_environment_guard',_guard_path)
_guard_module=_GuardImport.module_from_spec(_guard_spec)
_guard_spec.loader.exec_module(_guard_module)
verify_environment=_guard_module.verify_environment

import ctypes as c, json, os, sys, pathlib, hashlib, struct, re, subprocess
from ctypes import wintypes as w
if len(sys.argv)!=2 or len(sys.argv[1])>16000:raise RuntimeError('One bounded JSON request required')
cfg=json.loads(sys.argv[1])
if set(cfg)!={'engine','work','input','job'}:raise RuntimeError('Unknown or missing request fields')
identity=verify_environment()
mode=cfg['engine'];root=r'C:\ClaudeRelayRuntime';bindir=root+r'\texlive\bin\windows'
expected={'pdftex':('pdftex.dll','dllpdftexmain','199788b93da06b355cedc4bab1a3695e5c199413176020a708e7658eb2c835bf'),'pdflatex':('pdftex.dll','dllpdftexmain','199788b93da06b355cedc4bab1a3695e5c199413176020a708e7658eb2c835bf'),'xelatex':('xetex.dll','dllxetexmain','4c18ab0de9d32e053b5645fc5bed1c2b1498055e547a76a644db2070cd1c5b40'),'xdvipdfmx':('dvipdfmx.dll','dlldvipdfmxmain','b83b1d85416ec10c1c4bcb6917feb8f2b65cd3042cdaf80d46e1c1b98127aaa9')}
if mode not in expected:raise RuntimeError('Engine not in fixed allowlist')
temp=pathlib.Path(os.environ.get('TEMP',''))
scratch=temp.parent
if temp.name!='temp' or not re.fullmatch(r'C:\\Users\\user\\ClaudeRelayIsolation\\s\\[a-f0-9]{20}',str(scratch)):raise RuntimeError('Unexpected scratch environment')
work=pathlib.Path(cfg['work'])
relative=work.relative_to(scratch)
if not relative.parts or not re.fullmatch(r'tex-[a-f0-9]{10,32}',relative.parts[0]) or '..' in relative.parts:raise RuntimeError('Work must stay in one private TeX scratch tree')
if str(work.resolve(strict=True)).casefold()!=str(work).casefold() or not work.is_dir():raise RuntimeError('Work must be a physical directory')
name=cfg['input'];job=cfg['job']
if not isinstance(name,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}\.(tex|xdv)',name):raise RuntimeError('Staged input basename required')
if not isinstance(job,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',job):raise RuntimeError('Safe output job basename required')
source=work/name
if not source.is_file() or source.resolve(strict=True).parent!=work:raise RuntimeError('Input must be a regular file in the private work directory')
if source.suffix!=('.xdv' if mode=='xdvipdfmx' else '.tex'):raise RuntimeError('Engine/input mismatch')
if source.stat().st_size>32*1024*1024:raise RuntimeError('Input exceeds prototype limit')
for key,folder in [('TEXMFHOME','home'),('TEXMFVAR','var'),('TEXMFCONFIG','config'),('TEXMFCACHE','cache')]:
 target=work/folder;target.mkdir(exist_ok=True)
 if target.resolve(strict=True).parent!=work:raise RuntimeError('Cache must stay inside physical work')
 os.environ[key]=str(target)
os.environ.update({'command_line_encoding':'utf-8','TEXMFCNF':root+'/texlive;'+root+'/texlive/texmf-dist/web2c','TEXMFROOT':root+'/texlive','PATH':bindir+';'+os.environ['SystemRoot']+'\\System32','shell_escape':'0','openout_any':'p'})
dllname,entryname,wanted=expected[mode];dllpath=pathlib.Path(bindir)/dllname
if hashlib.sha256(dllpath.read_bytes()).hexdigest()!=wanted:raise RuntimeError('Unrecognized engine build')
os.chdir(work)
stem=job+'.'+mode+'.compat'
if mode=='xdvipdfmx':
 args=['xdvipdfmx','-o',str(work/(job+'.pdf')),str(source)]
else:
 args=[mode,'-cnf-line=command_line_encoding=utf-8','-interaction=nonstopmode','-halt-on-error','-no-shell-escape','-fmt='+mode,'-output-directory='+str(work),'-jobname='+job]
 if mode=='xelatex':args+=['-no-pdf','-progname=xelatex']
 args.append(str(source))

commandline_buffer=c.create_unicode_buffer(subprocess.list2cmdline(args))
class FDW(c.Structure):
 _fields_=[('attrs',w.DWORD),('ctime',w.FILETIME),('atime',w.FILETIME),('mtime',w.FILETIME),('high',w.DWORD),('low',w.DWORD),('reserved0',w.DWORD),('reserved1',w.DWORD),('name',w.WCHAR*260),('alternate',w.WCHAR*14)]
class FDA(c.Structure):
 _fields_=[('attrs',w.DWORD),('ctime',w.FILETIME),('atime',w.FILETIME),('mtime',w.FILETIME),('high',w.DWORD),('low',w.DWORD),('reserved0',w.DWORD),('reserved1',w.DWORD),('name',c.c_char*260),('alternate',c.c_char*14)]
class AD(c.Structure):
 _fields_=FDW._fields_[:6]
k=c.WinDLL('kernel32',use_last_error=True);invalid=c.c_void_p(-1).value
for suffix,typ,pth in [('A',FDA,c.c_char_p),('W',FDW,c.c_wchar_p)]:
 f=getattr(k,'FindFirstFile'+suffix);f.argtypes=[pth,c.POINTER(typ)];f.restype=w.HANDLE
 n=getattr(k,'FindNextFile'+suffix);n.argtypes=[w.HANDLE,c.POINTER(typ)];n.restype=w.BOOL
k.FindClose.argtypes=[w.HANDLE];k.FindClose.restype=w.BOOL
k.GetFileAttributesExW.argtypes=[w.LPCWSTR,c.c_int,c.POINTER(AD)];k.GetFileAttributesExW.restype=w.BOOL
for name in ['GetLongPathNameW','GetShortPathNameW']:
 f=getattr(k,name);f.argtypes=[w.LPCWSTR,w.LPWSTR,w.DWORD];f.restype=w.DWORD
k.VirtualProtect.argtypes=[w.LPVOID,c.c_size_t,w.DWORD,c.POINTER(w.DWORD)];k.VirtualProtect.restype=w.BOOL
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE];k.CreateFileW.restype=w.HANDLE
k.CloseHandle.argtypes=[w.HANDLE];k.CloseHandle.restype=w.BOOL
class IOSB(c.Structure):
 _fields_=[('status',c.c_void_p),('information',c.c_size_t)]
nt=c.WinDLL('ntdll');nt.NtQueryInformationFile.argtypes=[w.HANDLE,c.POINTER(IOSB),w.LPVOID,w.ULONG,c.c_int];nt.NtQueryInformationFile.restype=c.c_long
original={'A':k.FindFirstFileA,'W':k.FindFirstFileW};events=work/(stem+'.events.jsonl')
def event(v):
 # Diagnostics must never let a disk error escape through a native callback.
 try:
  with events.open('a',encoding='utf-8') as f:f.write(json.dumps(v)+'\n');f.flush()
 except OSError:
  pass
def make_callback(suffix,typ,pth):
 @c.WINFUNCTYPE(w.HANDLE,pth,c.POINTER(typ),use_last_error=True)
 def wrapped(p,out):
  h=original[suffix](p,out);err=c.get_last_error()
  if h!=invalid or err!=5 or p!=(root.encode('ascii') if suffix=='A' else root):
   c.set_last_error(err);return h
  borrowed=invalid
  try:
   attr=AD()
   if not k.GetFileAttributesExW(root,0,c.byref(attr)):raise RuntimeError('Root metadata unavailable')
   if not attr.attrs&0x10 or attr.attrs&0x400:raise RuntimeError('Root no longer a physical directory')
   namebuf=c.create_unicode_buffer(32768)
   if not k.GetLongPathNameW(root,namebuf,len(namebuf)) or namebuf.value.casefold()!=root.casefold():raise RuntimeError('Root canonical name mismatch')
   meta=k.CreateFileW(root,0x80,7,None,3,0x02000000,None)
   if meta==invalid:raise RuntimeError('Root attribute handle unavailable')
   try:
    info=c.create_string_buffer(65536);iosb=IOSB();status=nt.NtQueryInformationFile(meta,c.byref(iosb),info,len(info),21)&0xffffffff
    if status==0:
     n=int.from_bytes(info.raw[:4],'little')
     if n>26 or n%2:raise RuntimeError('Invalid alternate name length')
     shortname=info.raw[4:4+n].decode('utf-16-le')
    elif status==0xc0000034:shortname=''
    else:raise RuntimeError('Alternate name metadata status '+hex(status))
   finally:k.CloseHandle(meta)
   longname=namebuf.value.rsplit('\\',1)[-1]
   if shortname.casefold()==longname.casefold():shortname=''
   backing=typ();borrowed=original[suffix]((root+r'\texlive').encode('ascii') if suffix=='A' else root+r'\texlive',c.byref(backing))
   if borrowed==invalid:raise RuntimeError('Search backing handle unavailable')
   data=typ()
   for field in ['attrs','ctime','atime','mtime','high','low']:setattr(data,field,getattr(attr,field))
   data.name=longname.encode('ascii') if suffix=='A' else longname;data.alternate=shortname.encode('ascii') if suffix=='A' else shortname
   c.memmove(out,c.byref(data),c.sizeof(data));event({'event':'runtime-root-fallback','api':suffix,'attributes':attr.attrs,'name':longname,'alternate':shortname})
   c.set_last_error(0);return borrowed
  except BaseException as e:
   if borrowed!=invalid:k.FindClose(borrowed)
   event({'event':'fallback-failed','api':suffix,'error':str(e)});c.set_last_error(5);return invalid
 return wrapped
callbacks={'A':make_callback('A',FDA,c.c_char_p),'W':make_callback('W',FDW,c.c_wchar_p)}
k.GetCommandLineW.argtypes=[];k.GetCommandLineW.restype=c.c_void_p
@c.WINFUNCTYPE(c.c_void_p,use_last_error=True)
def intended_commandline():return c.addressof(commandline_buffer)
api_original={'FindFirstFileA':original['A'],'FindFirstFileW':original['W'],'GetCommandLineW':k.GetCommandLineW}
api_callbacks={'FindFirstFileA':callbacks['A'],'FindFirstFileW':callbacks['W'],'GetCommandLineW':intended_commandline}
checks=[]
for suffix,typ in [('A',FDA),('W',FDW)]:
 for name,expectedok in [(root,True),(root+r'\texlive',True),(r'C:\Users',False),(r'C:\*',False)]:
  out=typ();h=callbacks[suffix](name.encode('ascii') if suffix=='A' else name,c.byref(out));err=c.get_last_error();ok=h!=invalid;row={'api':suffix,'path':name,'ok':ok,'error':err if not ok else 0}
  if ok:
   if name==root:
    row['name']=out.name.decode('ascii') if suffix=='A' else out.name
    more=getattr(k,'FindNextFile'+suffix)(h,c.byref(out));row['nextOk']=bool(more);row['nextError']=c.get_last_error()
    if more or row['nextError']!=18:raise RuntimeError('Backing enumeration not single-result')
   row['closed']=bool(k.FindClose(h))
  checks.append(row)
  if ok!=expectedok:raise RuntimeError('Metadata preflight failed '+str(row))
(work/(stem+'.preflight.json')).write_text(json.dumps({'checks':checks,'dll':str(dllpath),'sha256':wanted,'command_line_encoding':os.environ.get('command_line_encoding')},indent=2),encoding='utf-8')
# Load only the pinned engine and its trusted directory dependencies. No file bytes change.
dll_search=os.add_dll_directory(bindir);engine=c.CDLL(str(dllpath),winmode=0x1100)
patchmodule=engine;patchname=dllname
if mode=='xdvipdfmx':
 patchname='kpathsealibw64.dll';patchpath=pathlib.Path(bindir)/patchname
 if hashlib.sha256(patchpath.read_bytes()).hexdigest()!='15cf439229281d38ab208b7598e20b3b248c1738e60d0bf2af80f01905ee7b8a':raise RuntimeError('Unrecognized shared kpathsea')
 patchmodule=c.CDLL(str(patchpath),winmode=0x1100)
base=patchmodule._handle
u16=lambda r:int.from_bytes(c.string_at(base+r,2),'little');u32=lambda r:int.from_bytes(c.string_at(base+r,4),'little')
pe=u32(0x3c);opt=pe+24
if u16(pe+4)!=0x8664 or u16(opt)!=0x20b:raise RuntimeError('Expected AMD64 PE32+')
size=u32(opt+56);ir=u32(opt+112+8);slots=[]
def bounded(r,n):
 if r<0 or r+n>size:raise RuntimeError('PE range out of bounds')
 return base+r
for i in range(128):
 d=struct.unpack('<IIIII',c.string_at(bounded(ir+i*20,20),20))
 if not any(d):break
 mod=c.string_at(bounded(d[3],1)).decode('ascii')
 if mod.lower()!='kernel32.dll':continue
 if not d[0]:raise RuntimeError('Missing import-name table')
 for j in range(1024):
  v=int.from_bytes(c.string_at(bounded(d[0]+8*j,8),8),'little')
  if v==0:break
  if v>>63:continue
  name=c.string_at(bounded(v+2,1)).decode('ascii')
  if name not in ['FindFirstFileA','FindFirstFileW','GetCommandLineW']:continue
  slot=bounded(d[4]+8*j,8);old=c.c_void_p.from_address(slot).value;suffix=name[-1]
  if old!=c.cast(api_original[name],c.c_void_p).value:raise RuntimeError('Unexpected existing IAT target')
  protection=w.DWORD()
  if not k.VirtualProtect(slot,8,4,c.byref(protection)):raise c.WinError(c.get_last_error())
  c.c_void_p.from_address(slot).value=c.cast(api_callbacks[name],c.c_void_p).value
  temp=w.DWORD()
  if not k.VirtualProtect(slot,8,protection.value,c.byref(temp)):raise c.WinError(c.get_last_error())
  slots.append((name,slot,old,protection.value))
if sorted(x[0] for x in slots)!=['FindFirstFileA','FindFirstFileW','GetCommandLineW']:raise RuntimeError('Exactly three compatibility imports required')
(work/(stem+'.iat-proof.json')).write_text(json.dumps({'module':patchname,'engine':dllname,'entry':entryname,'changedImports':[x[0] for x in slots],'protectionRestored':[x[3] for x in slots]},indent=2),encoding='utf-8')

event({'event':'environment-verified','identity':identity})
buffers=[c.create_string_buffer(x.encode('utf-8')) for x in args];argv=(c.POINTER(c.c_char)*(len(buffers)+1))(*[c.cast(b,c.POINTER(c.c_char)) for b in buffers],None)
entry=getattr(engine,entryname);entry.argtypes=[c.c_int,c.POINTER(c.POINTER(c.c_char))];entry.restype=c.c_int
event({'event':'engine-entry','entry':entryname,'argc':len(args),'argv0':args[0]})
rc=entry(len(args),argv)
for name,slot,old,protection in slots:
 temp=w.DWORD()
 if not k.VirtualProtect(slot,8,4,c.byref(temp)):raise c.WinError(c.get_last_error())
 c.c_void_p.from_address(slot).value=old
 if not k.VirtualProtect(slot,8,protection,c.byref(temp)):raise c.WinError(c.get_last_error())
event({'event':'engine-return','code':rc});sys.exit(rc)

