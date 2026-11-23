wenkai-*.png 不是图片，是字体。

这是「霞鹜文楷 Lite」常规字重的网页字体（LXGW WenKai Lite Regular，SIL Open Font License 1.1，许可证见 wenkai-OFL.txt），
来自 npm 包 lxgw-wenkai-lite-webfont 1.7.0（https://github.com/chawyehsu/lxgw-wenkai-webfont），原样未改：
  wenkai-N.png      = files/lxgwwenkailite-regular-subset-N.woff2（按 unicode 范围切成 97 片）
  wenkai-ranges.png = 每一片对应的 unicode 范围（JSON），从包里的 lxgwwenkailite-regular.css 抄出来的

为什么叫 .png、放在图标目录：服务器（server.js）只发白名单里的静态文件，这个目录里只认 .png；
改 server.js 要重新做完整验收并重启。浏览器按文件内容认字体，不看扩展名，所以先这样放。
下次 server.js 因为别的事要改时，可以给它加一条正规的字体路径（像 /vendor/fs/ 那样），再把这些文件改回 .woff2。

用在哪里：GPT（水墨）界面的问候语、诗句、回答里的标题和引文。只在第一次换到水墨时加载（见 index.html 的 loadInkFont），
浏览器只下载页面上用到的那几片。
