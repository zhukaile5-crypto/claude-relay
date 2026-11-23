using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Collections.Generic;
using System.Security.Principal;
using System.Web.Script.Serialization;
public class PrivateDesktopHostV2 {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,cbRes; public IntPtr res,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct SIX { public SI si; public IntPtr attrs; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int len;public IntPtr sd;[MarshalAs(UnmanagedType.Bool)]public bool inherit; }
 [StructLayout(LayoutKind.Sequential)] struct JBI { public long a,b;public uint flags;public UIntPtr min,max;public uint limit;public UIntPtr affinity;public uint priority,sched; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct JE { public JBI basic; public IO io;public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr exitStatus,peb,affinity,basePriority,processId,parentId; }
 [DllImport("ntdll.dll")]static extern int NtQueryInformationProcess(IntPtr process,int cls,out PBI info,uint size,out uint returned);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateDesktop(string n,IntPtr d,IntPtr dm,uint flags,uint access,ref SA sa);
 [DllImport("user32.dll",SetLastError=true)]static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint id);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetUserObjectInformation(IntPtr h,int ix,StringBuilder b,uint len,out uint needed);
 [DllImport("user32.dll",SetLastError=true)]static extern bool SetThreadDesktop(IntPtr d);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("user32.dll")]static extern bool DestroyWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int show);
 delegate bool EnumWin(IntPtr h,IntPtr p);
 [DllImport("user32.dll",SetLastError=true)]static extern bool EnumDesktopWindows(IntPtr desktop,EnumWin cb,IntPtr p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint rev,out IntPtr sd,out uint len);
 [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);
 [DllImport("kernel32.dll")]static extern uint SetErrorMode(uint mode);
 [DllImport("kernel32.dll")]static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll")]static extern void SetLastError(uint code);
 [DllImport("wer.dll")]static extern int WerSetFlags(uint flags);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr attr,IntPtr v,IntPtr size,IntPtr prev,IntPtr len);
 [DllImport("kernel32.dll")]static extern void DeleteProcThreadAttributeList(IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string exe,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateJobObject(IntPtr attr,string n);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool SetInformationJobObject(IntPtr h,int cl,ref JE info,uint len);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateJobObject(IntPtr j,uint code);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint ResumeThread(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)]static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenDesktop(string n,uint flags,bool inherit,uint access);
 [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr p,uint desired,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int c,out int value,uint len,out uint required);

 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateWindowStation(string n,uint flags,uint access,ref SA sa);
 [DllImport("user32.dll",SetLastError=true)]static extern bool SetProcessWindowStation(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll")]static extern bool CloseWindowStation(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenWindowStation(string n,bool inherit,uint access);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool IsProcessInJob(IntPtr proc,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetProcessTimes(IntPtr proc,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool QueryFullProcessImageName(IntPtr proc,uint flags,StringBuilder path,ref uint size);
 [DllImport("advapi32.dll",SetLastError=true)]static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr value,uint length,out uint required);
 static string ContainerSid(IntPtr process){IntPtr token;Check(OpenProcessToken(process,8,out token),"OpenProcessToken");try{int ac;uint len;Check(GetTokenInformation(token,29,out ac,4,out len),"IsAppContainer");if(ac!=1)throw new Exception("Not an AppContainer");GetTokenInformation(token,31,IntPtr.Zero,0,out len);IntPtr p=Marshal.AllocHGlobal((int)len);try{Check(GetTokenInformation(token,31,p,len,out len),"AppContainerSid");return new SecurityIdentifier(Marshal.ReadIntPtr(p)).Value;}finally{Marshal.FreeHGlobal(p);}}finally{CloseHandle(token);}}
 static long Created(IntPtr process){long c,e,k,u;Check(GetProcessTimes(process,out c,out e,out k,out u),"GetProcessTimes");return c;}
 static IntPtr CaptureParent(out uint pid,out long created){
  PBI info;uint returned;int status=NtQueryInformationProcess(GetCurrentProcess(),0,out info,(uint)Marshal.SizeOf(typeof(PBI)),out returned);
  if(status<0||returned<Marshal.SizeOf(typeof(PBI)))throw new Exception("Cannot establish launcher parent identity");
  long raw=info.parentId.ToInt64();if(raw<=0||raw>uint.MaxValue)throw new Exception("Invalid launcher parent identity");pid=(uint)raw;
  IntPtr parent=OpenProcess(0x1000|0x100000,false,pid);Check(parent!=IntPtr.Zero,"Open launcher parent");
  try{
   created=Created(parent);
   // A reused PID names a process born after this helper. Retain the checked handle,
   // rather than polling the PID, so identity cannot change during the run.
   if(created>Created(GetCurrentProcess()))throw new Exception("Launcher parent PID was reused");
   if(WaitForSingleObject(parent,0)!=258)throw new Exception("Launcher parent is no longer running");
   return parent;
  }catch{CloseHandle(parent);throw;}
 }
 static void ReadExact(Stream input,byte[] b){int at=0;while(at<b.Length){int n=input.Read(b,at,b.Length-at);if(n==0)throw new Exception("EOF during trusted guard handshake");at+=n;}}
 static IntPtr Desk(string name,string sid){IntPtr sd;uint n;Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+WindowsIdentity.GetCurrent().User.Value+")(A;;0xc7;;;"+sid+")S:(ML;;NW;;;LW)",1,out sd,out n),"desktop descriptor");try{SA sa=new SA();sa.len=Marshal.SizeOf(typeof(SA));sa.sd=sd;return CreateDesktop(name,IntPtr.Zero,IntPtr.Zero,0,0x1ff,ref sa);}finally{LocalFree(sd);}}
 static int Keep(string[] args){
  if(args.Length!=7)throw new Exception("keeper PID creationFileTime expectedImage expectedSid station job");
  uint pid=uint.Parse(args[1]);long created=long.Parse(args[2]);string image=Path.GetFullPath(args[3]),expectedSid=args[4],station=args[5],jobName=args[6];
  if(!station.StartsWith("Service-",StringComparison.Ordinal)||!jobName.StartsWith("Local\\RelayIsolation_",StringComparison.Ordinal))throw new Exception("Invalid trusted identity");
  uint parentPid;long parentCreated;IntPtr parent=CaptureParent(out parentPid,out parentCreated);
  IntPtr proc=OpenProcess(0x1000,false,pid),job=IntPtr.Zero,ws=IntPtr.Zero,desk=IntPtr.Zero,oldWs=GetProcessWindowStation();
  try{Check(proc!=IntPtr.Zero,"Open guard process");Check(Created(proc)==created,"Guard creation identity");
   var b=new StringBuilder(32768);uint n=32768;Check(QueryFullProcessImageName(proc,0,b,ref n),"Guard image");if(!Path.GetFullPath(b.ToString()).Equals(image,StringComparison.OrdinalIgnoreCase))throw new Exception("Guard image mismatch");
   string sid=ContainerSid(proc);if(sid!=expectedSid)throw new Exception("Guard SID mismatch");
   job=OpenJobObject(4,false,jobName);Check(job!=IntPtr.Zero,"Open trusted outer Job");bool inside;Check(IsProcessInJob(proc,job,out inside),"IsProcessInJob");if(!inside)throw new Exception("Guard is outside trusted Job");CloseHandle(job);job=IntPtr.Zero;
   uint exit;Check(GetExitCodeProcess(proc,out exit)&&exit==259,"Guard already exited");
   ws=OpenWindowStation(station,false,0xf037f);Check(ws!=IntPtr.Zero,"Open noninteractive station");Check(SetProcessWindowStation(ws),"Associate noninteractive station");
   string name="RelayExec_"+Guid.NewGuid().ToString("N");desk=Desk(name,sid);Check(desk!=IntPtr.Zero,"Create SID-only execution desktop");
   Console.WriteLine(json.Serialize(new{ok=true,desktop=name,station=station,appContainerSid=sid,pid=pid,created=created.ToString(),jobVerified=true}));Console.Out.Flush();
   var ended=new System.Threading.ManualResetEvent(false);
   var reader=new System.Threading.Thread(delegate(){try{while(Console.Read()!=-1){}}catch{}finally{ended.Set();}});reader.IsBackground=true;reader.Start();
   while(!ended.WaitOne(50)){uint state=WaitForSingleObject(parent,0);if(state==0)return 126;if(state!=258)throw new Exception("Launcher parent wait failed");}return 0;
  }finally{SetProcessWindowStation(oldWs);if(desk!=IntPtr.Zero)CloseDesktop(desk);if(ws!=IntPtr.Zero)CloseWindowStation(ws);if(job!=IntPtr.Zero)CloseHandle(job);if(proc!=IntPtr.Zero)CloseHandle(proc);CloseHandle(parent);}
 }
 static int Guard(string[] args){
  if(args.Length!=3)throw new Exception("guard expected-bootstrap-desktop nonce");
  string desktop=Name(GetThreadDesktop(GetCurrentThreadId())),station=Name(GetProcessWindowStation()),nonce=args[2];
  if(desktop!=args[1]||!station.StartsWith("Service-",StringComparison.Ordinal))throw new Exception("Guard not on expected noninteractive bootstrap desktop");
  IntPtr self=GetCurrentProcess();string sid=ContainerSid(self);long created=Created(self);
  Console.Error.WriteLine("RELAY_GUARD_READY "+json.Serialize(new{pid=Process.GetCurrentProcess().Id,created=created.ToString(),appContainerSid=sid,station=station,bootstrapDesktop=desktop,nonce=nonce}));Console.Error.Flush();
  Stream input=Console.OpenStandardInput();byte[] header=new byte[4];ReadExact(input,header);int len=(header[0]<<24)|(header[1]<<16)|(header[2]<<8)|header[3];if(len<2||len>64000)throw new Exception("Bad guard handshake length");byte[] payload=new byte[len];ReadExact(input,payload);
  var c=json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(payload));if((string)c["nonce"]!=nonce)throw new Exception("Guard nonce mismatch");
  string target=(string)c["desktop"];if(!target.StartsWith("RelayExec_",StringComparison.Ordinal))throw new Exception("Bad execution desktop");
  IntPtr desk=OpenDesktop(target,0,false,0xc7),attr=IntPtr.Zero,list=IntPtr.Zero;PI pi=new PI();bool launched=false;
  try{Check(desk!=IntPtr.Zero,"Open SID-only desktop");Check(SetThreadDesktop(desk),"Attach execution desktop");if(Name(GetThreadDesktop(GetCurrentThreadId()))!=target)throw new Exception("Desktop attach mismatch");
   string exe=(string)c["exe"],cwd=(string)c["cwd"];var av=(System.Collections.ArrayList)c["args"];var cmd=new StringBuilder(Quote(exe));foreach(object a in av)cmd.Append(" "+Quote(Convert.ToString(a)));
   var handles=new List<IntPtr>();foreach(int which in new int[]{-10,-11,-12}){IntPtr h=GetStdHandle(which);Check(h!=IntPtr.Zero&&h!=new IntPtr(-1),"Guard stdio");Check(SetHandleInformation(h,1,1),"Guard stdio inherit");if(!handles.Contains(h))handles.Add(h);}
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attr=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attr,1,0,ref size),"Guard attrs");
   list=Marshal.AllocHGlobal(IntPtr.Size*handles.Count);for(int i=0;i<handles.Count;i++)Marshal.WriteIntPtr(list,i*IntPtr.Size,handles[i]);Check(UpdateProcThreadAttribute(attr,0,(IntPtr)0x20002,list,(IntPtr)(IntPtr.Size*handles.Count),IntPtr.Zero,IntPtr.Zero),"Guard handle list");
   SIX si=new SIX();si.si.cb=Marshal.SizeOf(typeof(SIX));si.attrs=attr;si.si.desktop=station+"\\"+target;si.si.flags=0x100;si.si.input=GetStdHandle(-10);si.si.output=GetStdHandle(-11);si.si.error=GetStdHandle(-12);
   Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|4|0x08000000,IntPtr.Zero,cwd,ref si,out pi),"Guard child create");launched=true;
   if(ContainerSid(pi.process)!=sid)throw new Exception("Child AppContainer SID changed");Check(ResumeThread(pi.thread)!=0xffffffff,"Guard child resume");
   Console.Error.WriteLine("RELAY_GUARD_LAUNCHED "+json.Serialize(new{pid=pi.pid,desktop=target,station=station,appContainerSid=sid}));Console.Error.Flush();
   WaitForSingleObject(pi.process,0xffffffff);uint exit;Check(GetExitCodeProcess(pi.process,out exit),"Guard child exit");return unchecked((int)exit);
  }finally{if(launched){uint exit;if(GetExitCodeProcess(pi.process,out exit)&&exit==259)TerminateProcess(pi.process,125);}if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(attr!=IntPtr.Zero){DeleteProcThreadAttributeList(attr);Marshal.FreeHGlobal(attr);}if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(desk!=IntPtr.Zero)CloseDesktop(desk);}
 }
 static JavaScriptSerializer json=new JavaScriptSerializer();
 static void Check(bool ok,string n){if(!ok){int code=Marshal.GetLastWin32Error();throw new Win32Exception(code,n+" (Win32 error "+code+")");}}
 static string Name(IntPtr h){var s=new StringBuilder(512);uint n;Check(GetUserObjectInformation(h,2,s,1024,out n),"desktop name");return s.ToString();}
 static string Quote(string a){var b=new StringBuilder("\"");int n=0;foreach(char c in a){if(c=='\\'){n++;continue;}if(c=='"'){b.Append('\\',n*2+1);b.Append('"');n=0;continue;}b.Append('\\',n);n=0;b.Append(c);}b.Append('\\',n*2);b.Append('"');return b.ToString();}

 public static int Main(string[] args){
  SetErrorMode(0x8003);try{WerSetFlags(4);}catch{}
  if(args.Length>0&&args[0]=="--keep")return Keep(args);
  if(args.Length>0&&args[0]=="--guard")return Guard(args);
  if(args.Length==2&&args[0]=="--check-desktop"){string actual=Name(GetThreadDesktop(GetCurrentThreadId()));Console.WriteLine(json.Serialize(new{actual=actual,expected=args[1],matched=actual==args[1]}));return actual==args[1]?0:20;}
  if(args.Length!=1)return 2;
  var cfg=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(args[0]));
  string root=(string)cfg["root"],desktopName=(string)cfg["desktop"],exe=(string)cfg["exe"],cwd=(string)cfg["cwd"];
  var commandArgs=(System.Collections.ArrayList)cfg["args"];
  var envMap=(Dictionary<string,object>)cfg["env"];
  IntPtr newStation=IntPtr.Zero,oldStation=GetProcessWindowStation(),desk=IntPtr.Zero,orig=GetThreadDesktop(GetCurrentThreadId()),sd=IntPtr.Zero,attr=IntPtr.Zero,handles=IntPtr.Zero,envp=IntPtr.Zero,job=IntPtr.Zero,parent=IntPtr.Zero;
  uint parentPid=0;long parentCreated=0;bool parentExited=false;
  PI pi=new PI();bool assigned=false,created=false;FileStream output=null,input=null;uint exit=999;string error=null;int code=1;
  try{
   parent=CaptureParent(out parentPid,out parentCreated);
   if(!desktopName.StartsWith("RelayPrivate_")||desktopName.Contains("\\"))throw new Exception("invalid private name");
   uint len;string sid=WindowsIdentity.GetCurrent().User.Value;
   Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;"+sid+")(A;;0xc7;;;AC)(A;;0xc7;;;S-1-15-2-2)S:(ML;;NW;;;LW)",1,out sd,out len),"security descriptor");
   SA sa=new SA();sa.len=Marshal.SizeOf(typeof(SA));sa.sd=sd;sa.inherit=false;
   string stationName="Service";SA stationSa=new SA();stationSa.len=Marshal.SizeOf(typeof(SA));stationSa.sd=sd;newStation=CreateWindowStation(null,0,0xf037f,ref stationSa);Check(newStation!=IntPtr.Zero,"Automatic noninteractive window station");stationName=Name(newStation);if(!stationName.StartsWith("Service-",StringComparison.Ordinal))throw new Exception("Noninteractive station required");Check(SetProcessWindowStation(newStation),"SetProcessWindowStation");
   desk=CreateDesktop(desktopName,IntPtr.Zero,IntPtr.Zero,0,0x1ff,ref sa);Check(desk!=IntPtr.Zero,"CreateDesktop");Check(SetThreadDesktop(desk),"SetThreadDesktop");
   bool stdio=cfg.ContainsKey("stdio")&&Convert.ToBoolean(cfg["stdio"]);IntPtr hout,hin,herr;
   if(stdio){hin=GetStdHandle(-10);hout=GetStdHandle(-11);herr=GetStdHandle(-12);}
   else{output=new FileStream(Path.Combine(root,"process-output.txt"),FileMode.Create,FileAccess.Write,FileShare.ReadWrite);input=new FileStream(Path.Combine(root,"empty-input.txt"),FileMode.OpenOrCreate,FileAccess.Read,FileShare.ReadWrite);hout=output.SafeFileHandle.DangerousGetHandle();hin=input.SafeFileHandle.DangerousGetHandle();herr=hout;}
   var allowedHandles=new List<IntPtr>();foreach(IntPtr h in new IntPtr[]{hin,hout,herr}){if(h==IntPtr.Zero||h==new IntPtr(-1))throw new Exception("Invalid standard handle");Check(SetHandleInformation(h,1,1),"stdio inherit");if(!allowedHandles.Contains(h))allowedHandles.Add(h);}
   IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attr=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attr,1,0,ref size),"attrs");
   handles=Marshal.AllocHGlobal(IntPtr.Size*allowedHandles.Count);for(int i=0;i<allowedHandles.Count;i++)Marshal.WriteIntPtr(handles,IntPtr.Size*i,allowedHandles[i]);
   Check(UpdateProcThreadAttribute(attr,0,(IntPtr)0x20002,handles,(IntPtr)(IntPtr.Size*allowedHandles.Count),IntPtr.Zero,IntPtr.Zero),"handles");
   var env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);foreach(var kv in envMap)env[kv.Key]=Convert.ToString(kv.Value);
   if(cfg.ContainsKey("inheritEnvKeys")){foreach(object key in (System.Collections.ArrayList)cfg["inheritEnvKeys"]){string name=key as string;if(name!="CODEX_API_KEY")throw new Exception("Unsupported inherited environment key");string value=Environment.GetEnvironmentVariable(name);if(String.IsNullOrEmpty(value))throw new Exception("Required model environment is absent");env[name]=value;}}
   var et=new StringBuilder();foreach(var kv in env)et.Append(kv.Key+"="+kv.Value+'\0');et.Append('\0');envp=Marshal.StringToHGlobalUni(et.ToString());
   string jobName=cfg.ContainsKey("jobName")?(string)cfg["jobName"]:"Local\\RelayIsolation_"+Guid.NewGuid().ToString("N");if(!jobName.StartsWith("Local\\RelayIsolation_",StringComparison.Ordinal))throw new Exception("Invalid Job name");job=CreateJobObject(IntPtr.Zero,jobName);Check(job!=IntPtr.Zero,"job");JE info=new JE();info.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf(typeof(JE))),"job limits");
   var si=new SIX();si.si.cb=Marshal.SizeOf(typeof(SIX));si.attrs=attr;si.si.desktop=stationName+"\\"+desktopName;si.si.flags=0x100;si.si.input=hin;si.si.output=hout;si.si.error=herr;
   var cmd=new StringBuilder(Quote(exe));foreach(object a in commandArgs)cmd.Append(" "+Quote(Convert.ToString(a)));
   if(WaitForSingleObject(parent,0)!=258)throw new Exception("Launcher parent exited before child creation");
   Check(CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|4|0x08000000,envp,cwd,ref si,out pi),"CreateProcess");created=true;
   Check(AssignProcessToJobObject(job,pi.process),"AssignJob");assigned=true;Check(ResumeThread(pi.thread)!=0xffffffff,"Resume");
   var watch=Stopwatch.StartNew();uint timeout=cfg.ContainsKey("timeoutMs")?Convert.ToUInt32(cfg["timeoutMs"]):15000;
   while(true){
    uint childState=WaitForSingleObject(pi.process,50);if(childState==0)break;if(childState!=258)throw new Exception("Child process wait failed");
    uint parentState=WaitForSingleObject(parent,0);if(parentState==0){parentExited=true;TerminateJobObject(job,126);WaitForSingleObject(pi.process,3000);break;}
    if(parentState!=258)throw new Exception("Launcher parent wait failed");
    if(watch.ElapsedMilliseconds>=timeout){TerminateJobObject(job,124);WaitForSingleObject(pi.process,3000);break;}
   }
   Check(GetExitCodeProcess(pi.process,out exit),"exit");code=exit==0?0:1;
  }catch(Exception e){error=e.ToString();}
  finally{
   if(created){if(assigned)TerminateJobObject(job,125);else TerminateProcess(pi.process,125);WaitForSingleObject(pi.process,3000);}
   if(job!=IntPtr.Zero)CloseHandle(job);if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);if(parent!=IntPtr.Zero)CloseHandle(parent);
   if(input!=null)input.Dispose();if(output!=null)output.Dispose();
   if(attr!=IntPtr.Zero){DeleteProcThreadAttributeList(attr);Marshal.FreeHGlobal(attr);}if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(envp!=IntPtr.Zero)Marshal.FreeHGlobal(envp);
   SetProcessWindowStation(oldStation);SetThreadDesktop(orig);if(desk!=IntPtr.Zero)CloseDesktop(desk);if(newStation!=IntPtr.Zero)CloseWindowStation(newStation);if(sd!=IntPtr.Zero)LocalFree(sd);
   File.WriteAllText(Path.Combine(root,"launcher-result.json"),json.Serialize(new{exit=exit,code=code,error=error,privateDesktop=desktopName,pid=pi.pid,parentPid=parentPid,parentCreated=parentCreated.ToString(),parentExited=parentExited}));if(error!=null)Console.Error.WriteLine("Private desktop launch failed: "+error);
  }return code==0?0:(exit==999?1:unchecked((int)exit));
 }
}
