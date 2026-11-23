import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'ClaudeApp';

export default class EntryAbility extends UIAbility {
  private mainWindow: window.Window | null = null;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate<number>('launchAt', Date.now()); // 页面里据此打印启动各阶段耗时
    hilog.info(0x0000, TAG, 'timing onCreate');
    // 加快第一次打开：在界面还没建好时就先启动网页引擎，并提前和网站建立连接（DNS、TLS 握手）
    try {
      webview.WebviewController.initializeWebEngine();
      webview.WebviewController.prepareForPageLoad('https://claude-relay.example', true, 2);
    } catch (e) {
      hilog.warn(0x0000, TAG, 'web engine warm-up failed');
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.getMainWindow().then((w: window.Window) => {
      this.mainWindow = w;
      this.applyBarColors(this.context.config.colorMode);
    }).catch(() => {});
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
    });
  }

  // 系统切换深色/浅色模式时，状态栏和底部导航条跟着网页一起变
  onConfigurationUpdate(newConfig: Configuration): void {
    this.applyBarColors(newConfig.colorMode);
  }

  // 状态栏、导航条用和网页背景一样的颜色（网页的 --bg），看起来是一整块
  private applyBarColors(mode?: ConfigurationConstant.ColorMode): void {
    if (!this.mainWindow) return;
    const dark = mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    const bg = dark ? '#262624' : '#FAF9F5';
    const fg = dark ? '#FFFFFF' : '#000000';
    this.mainWindow.setWindowSystemBarProperties({
      statusBarColor: bg,
      navigationBarColor: bg,
      statusBarContentColor: fg,
      isStatusBarLightIcon: dark,
      isNavigationBarLightIcon: dark,
    }).catch(() => {});
  }

  // 切到后台时把登录 cookie 写盘，系统回收应用后再打开也不用重新登录
  onBackground(): void {
    webview.WebCookieManager.saveCookieAsync().catch(() => {});
  }
}
