# Claude 鸿蒙手机端

给 HarmonyOS 5 及以上的手机（纯血鸿蒙，不能装安卓 APK）做的原生应用。整个界面就是 https://claude-relay.example，和网页版、Windows 桌面端（仓库里的 `desktop/`）同一套：服务、账号、对话都不用改，网页更新后 App 自动跟着变。App 只补网页在手机上做不到或做不好的事：

| 功能 | 实现（`entry/src/main/ets/pages/Index.ets`） |
|---|---|
| 打开就是聊天界面 | ArkWeb `Web` 组件加载 `https://claude-relay.example/?source=app` |
| 长期保持登录 | 开启 DOM Storage（网页存登录凭证），页面加载完和切后台时把 cookie 写盘 |
| 上传照片/文件 | 网页点「+」时弹「照片和视频 / 文件」，用系统选择器挑，最多 9 个 |
| 下载文件 | 先下到应用缓存，下完弹系统「保存到」选择位置 |
| 语音输入 | 只放行本站的麦克风请求，第一次弹系统授权 |
| 返回手势 | 先关网页最上面一层（大图、弹窗、右侧面板、侧边栏、项目页、录音，见网页的 `relayBack()`），再网页后退，退到头把 App 收到后台（不退出） |
| 深色模式 | 网页跟随系统深色模式（ArkWeb `darkMode(Auto)`），状态栏、导航条颜色和网页背景一致 |
| 打开时的等待画面 | 网页画出内容前显示图标和「正在连接 Claude…」 |
| 站外链接 | 交给系统浏览器 |
| 断网 | 显示「连不上 Claude」和重试按钮；电脑睡着时照常显示网站自己的「Claude 在睡觉」页面 |

User-Agent 末尾带 `clauderelayHarmony/版本`，网页据此不再显示「添加到主屏幕」。

构建时要把这个文件夹放在纯英文路径下（下面的例子是 `D:\ClaudeHarmony`）：hvigor 要求项目路径只能有英文字母、数字和少数符号，中文路径（包括指向它的目录联接）会直接报错。

## 构建

DevEco Studio 26（`D:\DevEco Studio`）打开本文件夹即可。命令行构建（PowerShell）：

```powershell
$env:DEVECO_SDK_HOME = 'D:\DevEco Studio\sdk'; $env:JAVA_HOME = 'D:\DevEco Studio\jbr'
$env:PATH = "D:\DevEco Studio\jbr\bin;D:\DevEco Studio\tools\node;D:\DevEco Studio\tools\ohpm\bin;$env:PATH"
Set-Location D:\ClaudeHarmony
& 'D:\DevEco Studio\tools\hvigor\bin\hvigorw.bat' --mode module -p module=entry@default -p product=default -p buildMode=debug assembleHap --no-daemon
```

产物：`entry\build\default\outputs\default\entry-default-signed.hap`（配好签名后）或 `-unsigned.hap`（没配签名时，装不上手机）。

`compatibleSdkVersion` 是 `5.0.0(12)`：用到的接口都在 API 12 以内，HarmonyOS 5.0 及以上都能装。

## 签名和装到手机（第一次）

鸿蒙不允许装没签名的应用；调试签名只对登记过的手机有效（按设备 UDID 绑定）。

1. **华为开发者账号**：在 developer.huawei.com 用华为账号登录并完成实名认证。据华为的 FAQ，实名认证过的开发者，调试证书有效期 1 年；没认证的只有 14 天（以 AppGallery Connect 里显示的为准）。**证书过期后 App 会打不开，要连电脑重新签名安装**，所以一定先完成实名认证。
2. **手机打开开发者模式**：设置 → 关于手机 → 连续点「软件版本」7 次 → 返回 设置 → 系统 → 开发者选项，打开「USB 调试」。用数据线连电脑，手机上选「传输文件」，并在弹窗里允许这台电脑调试。
3. **DevEco Studio**：打开 `D:\ClaudeHarmony` → 右上角登录华为账号 → File → Project Structure → Project → Signing Configs，勾选「Automatically generate signature」→ Apply。自动签名会把**当前连着的手机**登记进调试证书。
4. 顶部设备栏选中手机，点运行（▶）。装好后桌面上出现 Claude 图标。

**换签名的坑（10-27 实测）**：实名认证后重新勾选自动签名，DevEco 会直接沿用本机 `C:\Users\<用户>\.ohos\config` 里还没过期的旧签名，不会重新申请。要换成新的，先把那里的 `default_ClaudeHarmony_*`（.cer/.csr/.p12/.p7b）和 `material` 文件夹一起挪走（只挪签名文件会报「解密失败」），再取消勾选、重新勾选自动签名。查有效期：`.p7b` 里的 `"validity":{"not-before":…,"not-after":…}`（Unix 秒）。当前签名：实名后生成，2026-10-27 至 2027-10-27。

命令行安装（已签名的 HAP）：

```powershell
& 'D:\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe' list targets
& 'D:\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe' install -r entry\build\default\outputs\default\entry-default-signed.hap
```

## 装到另一台手机

另一台手机也要按第 2 步打开开发者模式和 USB 调试，连上电脑后**再做一次第 3 步**（重新勾一次自动签名，把这台手机也登记进去），然后第 4 步安装。

**先在自己的手机上确认**：装好后把「USB 调试」和「开发者模式」关掉，重启手机，看 App 还能不能正常打开。我不确定调试签名的应用在关闭开发者模式后是否还能运行；如果不能，那台手机就得一直开着开发者模式。

## 已知限制

- **回复完成的通知**：App 在后台会被系统冻结，网页的实时推送断开，所以不会像桌面端那样弹「回复好了」。要做到需要接入华为推送（Push Kit），服务端也要改，暂未做。
- **调试证书会过期**（见上）。长期方案是上架 AppGallery 或用 AppGallery Connect 的测试分发，审核对「网页套壳」类应用不一定通过，暂未做。
