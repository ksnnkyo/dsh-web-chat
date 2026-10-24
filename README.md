# dsh-web-chat

DeepSeek Harness 桌面端插件：在侧栏管理 DeepSeek 网页会话，在主区域阅读和继续对话，并把选定内容交给 Harness 任务。

包名与界面名称均为 **dsh-web-chat**，独立版本从 **0.1.0** 开始。目前为本地待发布版本。

## 功能

- 网页会话列表、搜索、置顶、删除和本地分组。
- 会话区与工作区按约 40% / 60% 分配可用列表高度，各自滚动；收起会话区后工作区获得更多空间。
- 隐藏原网页的重复导航与会话列表；初始化完成后再显示对话，减少首次打开时的页面闪动。
- “交给 Harness”支持最近一轮、最后一条回复或整段对话，选择工作区或返回上一个任务，并在预览后填入草稿。保留已有草稿，不自动发送；读取不完整时提示。
- 本机登录态持久化、用量与余额显示、可配置快捷键。

## 安装

需要 Node.js 24+、DeepSeek Harness 0.2.1-rc.2+。本版本尚未发布到 npm，请先使用本地源码或安装包验证。

在源码目录执行：

```sh
npm ci
npm run release:check
npm pack
```

使用 Harness 插件管理器安装生成的 `dsh-web-chat-0.1.0.tgz`，或在命令行执行（替换实际路径）：

```sh
dsh plugin --profile desktop add /absolute/path/dsh-web-chat-0.1.0.tgz
```

正式发布后才可使用 `dsh plugin --profile desktop add dsh-web-chat`。不要同时启用旧插件 `dsh-deepseek-webdesk`，避免重复侧栏和快捷键。

## 旧版迁移与数据

首次启用会将旧目录 `~/.dsh/deepseek-webdesk` 中有效的登录快照和快捷键设置复制到 `~/.dsh/dsh-web-chat`；新目录已有文件时不覆盖。旧数据保留，用量缓存与快捷键辅助程序重新生成。设置 `DSH_HOME` 时以上路径均相对于该目录。

本地分组等界面偏好从旧键 `dsh-deepseek-webdesk.ui.v1` 复制到 `dsh-web-chat.ui.v1`，仅在新键不存在时迁移。以后两个版本的数据分别保存。

登录快照包含账号凭据，仅保存在本机，权限为 600；请勿提交或分享该文件。对话交接以当时读取的文字为准，图片、附件和生成中的内容可能不完整，请检查预览。

## 开发与发布

`npm test` 执行回归测试；`npm run check` 检查语法；`npm run release:check` 运行检查、测试和打包预览。发布步骤见 [发布说明](docs/RELEASING.md)。npm 包只包含运行文件、语言文件、图标及公开说明，不包含测试、开发计划或历史截图。

源码仓库：[ksnnkyo/dsh-deepseek-webdesk](https://github.com/ksnnkyo/dsh-deepseek-webdesk)。仓库目录名与包名可以不同。

## 来源与许可

基于 [zneoxlab/dsh-deepseek-webdesk](https://github.com/zneoxlab/dsh-deepseek-webdesk) 开发，由 ksnnkyo 独立维护，非 DeepSeek 官方插件。保留原作者 MIT 许可与版权声明，详见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。
