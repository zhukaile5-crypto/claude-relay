// Claude 鸿蒙手机端：整个界面就是 https://claude-relay.example（和网页版、桌面端同一套），
// 这里只补网页在手机上做不到或做不好的事：上传选照片/文件、下载保存到手机、语音输入的麦克风权限、
// 返回手势、站外链接交给系统浏览器、断网提示页、长期保持登录。
import { webview } from '@kit.ArkWeb';
import { abilityAccessCtrl, common, Want } from '@kit.AbilityKit';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const ORIGIN = 'https://claude-relay.example';
const HOME = ORIGIN + '/?source=app';
const UA_TAG = ' clauderelayHarmony/1.0.0';

interface DownloadTask {
  path: string;
  name: string;
}

// 启动耗时日志：hdc shell "hilog -x" | findstr timing
const logTiming = (stage: string): void => {
  const t0 = AppStorage.get<number>('launchAt') ?? Date.now();
  hilog.info(0x0000, 'ClaudeApp', 'timing %{public}s +%{public}d ms', stage, Date.now() - t0);
};

const isOwnSite = (url: string): boolean => url === ORIGIN || url.startsWith(ORIGIN + '/') || url.startsWith(ORIGIN + '?');
// 文件名里不能出现的字符换掉
const safeName = (name: string): string => (name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private downloads: Map<string, DownloadTask> = new Map();
  private ctx: common.UIAbilityContext | null = null;
  @State loadFailed: boolean = false;
  // 打开 App 到网页真正画出内容之间（移动网络下要 2~3 秒）显示的等待画面，免得看起来是空白
  @State connecting: boolean = true;

  private hideConnecting(): void {
    this.connecting = false;
  }

  aboutToAppear(): void {
    this.ctx = getContext(this) as common.UIAbilityContext;
  }

  // 系统返回手势：先让网页关掉最上面的一层（侧边栏、文件预览、弹窗、录音……，见 index.html 的 relayBack），
  // 没有可关的就网页后退；退到头时把 App 收到后台而不是退出，下次打开还停在原来的地方
  onBackPress(): boolean {
    if (this.loadFailed) return false;
    this.controller.runJavaScript('window.relayBack ? window.relayBack() : false')
      .then((closed: string) => {
        if (closed !== 'true') this.goBackOrHide();
      })
      .catch(() => this.goBackOrHide());
    return true;
  }

  private goBackOrHide(): void {
    try {
      if (this.controller.accessBackward()) {
        this.controller.backward();
        return;
      }
    } catch (e) {
      // 网页还没加载好
    }
    this.ctx?.moveAbilityToBackground().catch(() => {});
  }

  private toast(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message });
    } catch (e) {
      // 页面正在退出
    }
  }

  // ---------- 下载：先存到应用自己的缓存里，下完再让用户选存到手机的哪里 ----------
  private makeDownloadDelegate(): webview.WebDownloadDelegate {
    const delegate = new webview.WebDownloadDelegate();
    delegate.onBeforeDownload((item: webview.WebDownloadItem) => {
      const name = safeName(item.getSuggestedFileName());
      const path = `${this.ctx!.cacheDir}/dl_${Date.now()}_${name}`;
      this.downloads.set(item.getGuid(), { path, name });
      item.start(path);
      this.toast(`正在下载 ${name}`);
    });
    delegate.onDownloadFinish((item: webview.WebDownloadItem) => {
      const task = this.downloads.get(item.getGuid());
      this.downloads.delete(item.getGuid());
      if (task) this.saveToPhone(task);
    });
    delegate.onDownloadFailed((item: webview.WebDownloadItem) => {
      const task = this.downloads.get(item.getGuid());
      this.downloads.delete(item.getGuid());
      this.toast(`${task ? task.name : '文件'} 下载失败，再试一次吧`);
      if (task) this.removeQuietly(task.path);
    });
    return delegate;
  }

  private async saveToPhone(task: DownloadTask): Promise<void> {
    try {
      const options = new picker.DocumentSaveOptions();
      options.newFileNames = [task.name];
      const uris = await new picker.DocumentViewPicker(this.ctx!).save(options);
      if (!uris || !uris.length) return; // 用户点了取消
      const src = fs.openSync(task.path, fs.OpenMode.READ_ONLY);
      const dst = fs.openSync(uris[0], fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try {
        fs.copyFileSync(src.fd, dst.fd);
      } finally {
        fs.closeSync(src);
        fs.closeSync(dst);
      }
      this.toast(`已保存 ${task.name}`);
    } catch (e) {
      this.toast(`没能保存 ${task.name}`);
    } finally {
      this.removeQuietly(task.path);
    }
  }

  private removeQuietly(path: string): void {
    try {
      fs.unlinkSync(path);
    } catch (e) {
      // 文件本来就不在
    }
  }

  // ---------- 上传：网页里点「+」时，让用户选从相册还是从文件里挑 ----------
  private async pickFiles(result: FileSelectorResult, multiple: boolean): Promise<void> {
    let uris: string[] = [];
    try {
      const choice = await this.getUIContext().getPromptAction().showActionMenu({
        title: '添加文件',
        buttons: [
          { text: '照片和视频', color: '#141413' },
          { text: '文件', color: '#141413' },
        ],
      });
      if (choice.index === 0) {
        const options = new photoAccessHelper.PhotoSelectOptions();
        options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_VIDEO_TYPE;
        options.maxSelectNumber = multiple ? 9 : 1;
        uris = (await new photoAccessHelper.PhotoViewPicker().select(options)).photoUris;
      } else {
        const options = new picker.DocumentSelectOptions();
        options.maxSelectNumber = multiple ? 9 : 1;
        uris = await new picker.DocumentViewPicker(this.ctx!).select(options);
      }
    } catch (e) {
      uris = []; // 关掉了菜单或选择器
    }
    result.handleFileList(uris); // 一定要回应，否则网页里的选择框会一直卡住
  }

  // ---------- 语音输入：只给自己网站的麦克风请求，第一次会弹系统授权框 ----------
  private async handlePermission(request: PermissionRequest): Promise<void> {
    const wanted = request.getAccessibleResource();
    const audioOnly = wanted.length > 0 && wanted.every((r: string) => r === ProtectedResourceType.AUDIO_CAPTURE);
    if (!isOwnSite(request.getOrigin()) || !audioOnly) {
      request.deny();
      return;
    }
    try {
      const res = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.ctx!, ['ohos.permission.MICROPHONE']);
      if (res.authResults[0] === 0) request.grant(wanted);
      else {
        request.deny();
        this.toast('需要在 设置 → 应用 → Claude 里允许使用麦克风');
      }
    } catch (e) {
      request.deny();
    }
  }

  // 站外链接（论文、参考网页等）交给系统浏览器打开
  private openExternal(url: string): void {
    const want: Want = { action: 'ohos.want.action.viewData', entities: ['entity.system.browsable'], uri: url };
    this.ctx!.startAbility(want).catch(() => {
      this.toast('没能打开这个链接');
    });
  }

  private retry(): void {
    this.loadFailed = false;
    this.connecting = true;
    try {
      this.controller.loadUrl(HOME);
    } catch (e) {
      this.loadFailed = true;
    }
  }

  build() {
    Stack() {
      Web({ src: HOME, controller: this.controller })
        .width('100%')
        .height('100%')
        .backgroundColor($r('app.color.page_background'))
        .javaScriptAccess(true)
        .domStorageAccess(true) // 网页的登录凭证、选过的模型等存在 localStorage 里
        .fileAccess(false)
        .geolocationAccess(false)
        .mixedMode(MixedMode.None)
        .darkMode(WebDarkMode.Auto) // 跟随系统深色模式，用网页自己的深色配色（和网页版、桌面端一样）
        .forceDarkAccess(false)
        .keyboardAvoidMode(WebKeyboardAvoidMode.RESIZE_CONTENT) // 键盘弹出时输入框不被挡住
        .onControllerAttached(() => {
          logTiming('controllerAttached');
          try {
            this.controller.setCustomUserAgent(this.controller.getUserAgent() + UA_TAG);
            this.controller.setDownloadDelegate(this.makeDownloadDelegate());
          } catch (e) {
            // 只影响下载和网页识别桌面端，不影响聊天
          }
        })
        .onPageBegin(() => logTiming('pageBegin'))
        .onFirstMeaningfulPaint(() => {
          logTiming('firstMeaningfulPaint');
          this.hideConnecting();
        })
        .onPageEnd(() => {
          logTiming('pageEnd');
          // 有的页面不会触发「首次有效绘制」：加载完再等一会儿也收起等待画面
          setTimeout(() => this.hideConnecting(), 2500);
          // 网页自己记录的各阶段耗时（相对于开始请求）：DNS、连接、TLS、首字节、HTML 下完、DOM 就绪、全部加载
          const perfJs = 'JSON.stringify((()=>{const n=performance.getEntriesByType("navigation")[0]||{};const r=(k)=>Math.round(n[k]||0);' +
            'const res=performance.getEntriesByType("resource");return {dnsEnd:r("domainLookupEnd"),connectEnd:r("connectEnd"),tlsStart:r("secureConnectionStart"),' +
            'ttfb:r("responseStart"),htmlDone:r("responseEnd"),domReady:r("domContentLoadedEventEnd"),load:r("loadEventEnd"),proto:n.nextHopProtocol,' +
            'htmlKB:Math.round((n.transferSize||0)/1024),resources:res.length,fromCache:res.filter(x=>x.transferSize===0).length,' +
            'slowest:res.sort((a,b)=>b.duration-a.duration).slice(0,4).map(x=>x.name.replace(location.origin,"")+":"+Math.round(x.duration))}})())';
          this.controller.runJavaScript(perfJs).then((s: string) => {
            hilog.info(0x0000, 'ClaudeApp', 'timing perf %{public}s', s);
          }).catch(() => {});
          // 登录 cookie 立刻写盘，应用被系统清掉后也不用重新登录
          webview.WebCookieManager.saveCookieAsync().catch(() => {});
        })
        .onErrorReceive((event: OnErrorReceiveEvent) => {
          // 只管整页打不开（断网、域名解析失败）；电脑睡着时 Cloudflare 会返回「Claude 在睡觉」页面，不走这里
          if (event.request.isMainFrame()) this.loadFailed = true;
        })
        .onLoadIntercept((event: OnLoadInterceptEvent) => {
          const url = event.data.getRequestUrl();
          if (isOwnSite(url) || !event.data.isMainFrame()) return false;
          if (/^(https?|mailto|tel):/i.test(url)) {
            this.openExternal(url);
            return true;
          }
          return false;
        })
        .onShowFileSelector((event: OnShowFileSelectorEvent) => {
          this.pickFiles(event.result, event.fileSelector.getMode() === FileSelectorMode.FileOpenMultipleMode);
          return true;
        })
        .onPermissionRequest((event: OnPermissionRequestEvent) => {
          this.handlePermission(event.request);
        })

      if (this.connecting && !this.loadFailed) {
        Column({ space: 16 }) {
          Image($r('app.media.icon')).width(72).height(72).borderRadius(16)
          LoadingProgress().width(28).height(28).color($r('app.color.accent'))
          Text('正在连接 Claude…').fontSize(15).fontColor($r('app.color.text_muted'))
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor($r('app.color.page_background'))
        .transition(TransitionEffect.OPACITY.animation({ duration: 200 }))
      }

      if (this.loadFailed) {
        Column({ space: 12 }) {
          Image($r('app.media.icon')).width(72).height(72).borderRadius(16)
          Text('连不上 Claude').fontSize(22).fontColor($r('app.color.text_primary'))
          Text('看看手机有没有联网，然后再试一次').fontSize(15).fontColor($r('app.color.text_muted'))
          Button('再试一次')
            .margin({ top: 12 })
            .backgroundColor($r('app.color.accent'))
            .onClick(() => this.retry())
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor($r('app.color.page_background'))
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_background'))
  }
}
