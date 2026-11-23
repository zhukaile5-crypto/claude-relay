import os,sys,json,pathlib,subprocess,importlib.util,tempfile
root=pathlib.Path.cwd()/'probe-work'
root.mkdir(exist_ok=True);os.chdir(root)
os.environ['MPLBACKEND']='Agg'
os.environ.setdefault('MPLCONFIGDIR',str(root/'mpl'))
pathlib.Path(os.environ['MPLCONFIGDIR']).mkdir(parents=True,exist_ok=True)
os.environ['QT_QPA_PLATFORM']='offscreen'
r=json.load(sys.stdin);role=r['role'];rt=pathlib.Path(r['runtime'])
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120,creationflags=0x08000000)
 if p.returncode:raise RuntimeError(str(args[:3])+' failed '+str(p.returncode)+' '+p.stderr[-3000:]+' '+p.stdout[-1000:])
 return p.stdout.strip()
checks={};report={'role':role}
if role=='docs':
 import numpy as np,pandas as pd
 from PIL import Image,ImageDraw,ImageFont
 img=Image.new('RGB',(900,180),'white');ImageDraw.Draw(img).text((25,50),'ISOLATION TEST 42',fill='black',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',52));img.save('ocr.png')
 run([sys.executable,'-X','utf8','-I','-S',str(rt/'tools'/'ocr.py'),'ocr.png','-o','ocr.txt'])
 text=' '.join(pathlib.Path('ocr.txt').read_text(encoding='utf-8').split())
 report['ocrText']=text;checks['ocr']=text=='ISOLATION TEST 42'
 x=np.arange(12,dtype=float);df=pd.DataFrame({'x':x,'y':2*x+3});slope,intercept=map(float,np.polyfit(df['x'].to_numpy(),df['y'].to_numpy(),1))
 report.update(slope=slope,intercept=intercept);checks['scientific']=abs(slope-2)<1e-10 and abs(intercept-3)<1e-10 and float(df['y'].sum())==168
elif role=='html':
 from PIL import Image
 pathlib.Path('poster.html').write_text('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:640px;height:360px;background:#f1e5cd;font:42px Arial}h1{padding:40px;color:#183f43}</style><h1>Closed Runtime 42</h1>',encoding='utf-8')
 run([sys.executable,'-X','utf8','-I','-S',str(rt/'tools'/'render_html.py'),'poster.html','poster.png','640','360'])
 checks['render']=Image.open('poster.png').size==(640,360)
 fixture=root/'asset-flow';pages=fixture/'pages';shared=fixture/'shared';styles=pages/'styles'
 styles.mkdir(parents=True,exist_ok=True);shared.mkdir(exist_ok=True)
 Image.new('RGB',(32,32),'#ff0000').save(pages/'same.png');Image.new('RGB',(32,32),'#00ff00').save(shared/'parent.png');Image.new('RGB',(16,16),'#abcdef').save(shared/'pattern.png')
 (pages/'script.js').write_text("document.getElementById('js').style.background='#112233';",encoding='utf-8')
 (shared/'theme.css').write_text("body{margin:0;background:#f1e5cd}#css{background:#445566}",encoding='utf-8')
 (styles/'main.css').write_text("@import '../../shared/theme.css'; #pattern{background-image:url('../../shared/pattern.png')}",encoding='utf-8')
 (pages/'index.html').write_text('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles/main.css"><style>.box{position:absolute;width:32px;height:32px;top:20px} #js{left:100px} #css{left:140px} #pattern{left:180px}</style><img class="box" style="left:20px" src="same.png"><img class="box" style="left:60px" src="../shared/parent.png"><div id="js" class="box"></div><div id="css" class="box"></div><div id="pattern" class="box"></div><script src="script.js"></script>',encoding='utf-8')
 run([sys.executable,'-X','utf8','-I','-S',str(rt/'tools'/'render_html.py'),str(pages/'index.html'),'asset-flow.png','640','360'])
 image=Image.open('asset-flow.png').convert('RGB')
 expected=[((25,25),(255,0,0)),((65,25),(0,255,0)),((105,25),(17,34,51)),((145,25),(68,85,102)),((185,25),(171,205,239))]
 report['pixels']=[image.getpixel(p) for p,_ in expected];checks['assets']=all(image.getpixel(p)==c for p,c in expected)
 spec=importlib.util.spec_from_file_location('assets',str(rt/'tools'/'render_assets.py'));assets=importlib.util.module_from_spec(spec);spec.loader.exec_module(assets)
 (pages/'escape.html').write_text('<img src="../../../../outside.png">',encoding='utf-8')
 refused=False
 with tempfile.TemporaryDirectory(dir=os.environ['TEMP']) as target:
  try:assets.stage_static_page(pages/'escape.html',target,os.environ['RELAY_WORKSPACE'])
  except ValueError:refused=True
 checks['escapeRefused']=refused
elif role=='gpu':
 import numpy as np,pandas as pd,torch
 checks['cuda']=torch.cuda.is_available()
 a=torch.arange(16,dtype=torch.float32,device='cuda').reshape(4,4);value=float((a@a).cpu().numpy()[0,0])
 checks['matrix']=abs(value-56)<1e-5;report['device']=torch.cuda.get_device_name(0)
 rng=np.random.default_rng(42);n=2400;group=np.arange(n)%4;frame=np.arange(n)//4
 pd.DataFrame({'x [nm]':group*350+rng.normal(0,22,n)+100,'y [nm]':group%2*450+rng.normal(0,22,n)+100,'Δx [nm]':np.full(n,22),'Δy [nm]':np.full(n,22),'t [ms]':frame*10,'frame':frame}).to_csv('locs.csv',index=False)
 tool=str(rt/'skills'/'smlm-analysis'/'scripts'/'smlm_tools.py')
 for command,extra in [('summary',[]),('render',['--px','10']),('nena',[]),('frc',['--px','10','--repeats','2']),('drift',['--segments','4','--px','10']),('cluster',['--eps','65','--minpts','8'])]:
  run([sys.executable,'-I','-S',tool,command,'locs.csv',*extra,'--out','smlm-'+command])
 checks['smlm']=True
elif role=='eve':
 import numpy as np,pandas as pd,h5py
 from eve_smlm.CandidateFitting.PhasorFitting import PhasorFitting
 rng=np.random.default_rng(7);n=2000
 events=pd.DataFrame({'x':np.clip(np.rint(rng.normal(20,2,n)),10,30).astype(int),'y':np.clip(np.rint(rng.normal(24,2,n)),14,34).astype(int),'p':np.ones(n,dtype=int),'t':np.arange(n)*20})
 loc,info=PhasorFitting({0:{'events':events,'N_events':n,'cluster_size':[21,21,40000]}},{'Multithread':{'value':'False'},'PixelSize_nm':{'value':100}},dist_kwarg='Hist2d_xy')
 checks['fit']=len(loc)==1 and bool(np.isfinite(loc[['x','y','t']].to_numpy()).all())
 dt=np.dtype([('x','<u2'),('y','<u2'),('p','<i2'),('t','<i8')])
 ev=np.zeros(200,dtype=dt);ev['x']=np.arange(200)%32;ev['y']=np.arange(200)*3%32;ev['p']=np.arange(200)%2;ev['t']=np.arange(200)*1000
 header='% camera_integrator_name Prophesee\n% plugin_integrator_name Prophesee\n% evt 2.0\n% format EVT2;height=64;width=64\n% geometry 64x64\n% end\n'
 words=[]
 for e in ev:
  t=int(e['t']);words += [(8<<28)|(t>>6),(int(e['p'])<<28)|((t&63)<<22)|(int(e['x'])<<11)|int(e['y'])]
 pathlib.Path('synthetic.raw').write_bytes(header.encode('ascii')+np.asarray(words,dtype='<u4').tobytes())
 tool=str(rt/'skills'/'event-camera-data'/'scripts'/'events_tools.py')
 run([sys.executable,'-I','-S',tool,'raw2h5','synthetic.raw','--out','synthetic.hdf5'])
 with h5py.File('synthetic.hdf5','r') as h:decoded=h['CD/events'][()]
 checks['rawRoundTrip']=len(decoded)==len(ev) and all(np.array_equal(decoded[f],ev[f]) for f in dt.names)
elif role=='media':
 from PIL import Image
 Image.new('RGB',(640,360),'#f1e5cd').save('slide.png')
 spec={'output':'video.mp4','size':[640,360],'subtitles':True,'slides':[{'image':'slide.png','text':'这是视频合成测试。','audio':r['audio']},{'image':'slide.png','text':'','seconds':1}]}
 pathlib.Path('spec.json').write_text(json.dumps(spec,ensure_ascii=False),encoding='utf-8')
 run([sys.executable,'-I','-S',str(rt/'tools'/'make_video.py'),'spec.json'])
 meta=json.loads(run([r['ffprobe'],'-v','error','-show_streams','-show_format','-of','json','video.mp4']))
 kinds={s['codec_type'] for s in meta['streams']};report['duration']=float(meta['format']['duration'])
 run([r['ffmpeg'],'-nostdin','-v','error','-y','-ss','1','-i','video.mp4','-frames:v','1','video-check.png'])
 checks['video']={'audio','video'}<=kinds and pathlib.Path('video-check.png').stat().st_size>0
else:raise ValueError(role)
report['checks']={k:bool(v) for k,v in checks.items()}
print('RUNTIME_PROBE_RESULT '+json.dumps(report,ensure_ascii=True,default=str))
