# 白日梦 Daydream 1.18.0

豆包字幕翻译增加相邻原文上下文，并尽量按句末、停顿及输入长度分批。字幕缓存按视频和位置隔离；长内容自动分段，编号异常回退，保留现有时间轴、失败恢复、请求共享及优先级。没有新增权限或第三方依赖。

**[Chrome 商店正式安装入口](https://chromewebstore.google.com/detail/dnpdkhjoephecffekgldnaooolnffeih)**。1.18.0 的商店更新已提交审核，审核通过并发布后才会分发，当前正式版本以商店页面为准。

手动安装可下载 `daydream-1.18.0.zip`，解压后在 `chrome://extensions` 开启开发者模式，加载包含 `manifest.json` 的目录。`daydream-1.18.0-source.zip` 是源码包；`SHA256SUMS.txt` 提供校验值。需要 Chrome 138 或更新版本，安装或更新后刷新页面。

验证：控制开关、Shorts 选择、后台、失败恢复、上下文和缓存检查通过；独立浏览器字幕显示检查通过；实际加载 MV3 安装包的脚本注入、服务进程通信、播放进度、过期隐藏、开关和设置检查通过。全部使用模拟字幕及模拟云接口，没有调用付费模型。真实 YouTube 播放、豆包翻译质量和延迟尚未用真实接口验收。

维护者：hesay77-cmyk，MIT 许可。数据处理说明见 PRIVACY.md。
