# dsh-deepseek-desk

> **DeepSeek 网页工作台 for DeepSeek Harness (DSH)** — 把 DeepSeek 网页版的会话列表搬进 DSH 侧栏，点开就是完整的网页对话，并支持把对话接力到当前任务或新建任务。

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4D6BFE)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-3%20passed-brightgreen)](#开发)

![DeepSeek 网页工作台：左侧是网页版会话列表，右侧是完整网页对话](docs/screenshot-desk.png)

## 它是什么

DSH（DeepSeek Harness）桌面端插件。安装后，左侧栏「工作区」下面会多出一块 **「会话」**，直接列出你 DeepSeek 网页版里的历史会话；点任意一条，主区域打开完整的 `chat.deepseek.com`，并自动跳到那条对话。

不是浮层、不是侧栏面板、也不是新开浏览器——它复用 DSH 自带的内嵌浏览器租约，并把网页登录态一起带过来。

## 功能

- **侧栏会话列表**：网页版历史会话（标题 + 时间），20 秒自动刷新。
  - 悬停行显示 **置顶 / 删除**（与 DSH 工作区会话行同款交互；置顶同步 DeepSeek 云端，删除有确认弹窗）。
  - 点「会话」标题折叠/展开；底部「显示更多」每次多加载 20 条。
- **完整网页对话**：点会话进入独立 DeepSeek 页，页面铺满主内容区。
  - 顶部是插件自己的头部：`DeepSeek · 当前会话标题` + 刷新 / 接力 / 在浏览器打开 / 右侧栏。
  - 中文界面（DSH 渲染进程默认 `--lang=en-US`，插件会强制 DeepSeek 网页使用 `zh_CN`）。
- **复用 DSH 网页登录态**：如果装了 [`dsh-deepseek-web-login`](https://github.com/cv-superding/dsh-deepseek-web-login)，打开网页时会自动读取它已登录的账号（token + cookie + 真实 UA），直接进已登录状态，无需再登一次。
- **接力到 Harness**：两种去向，各支持「最后一条回复 / 整段对话 / 当前一轮问答」：
  - **插入到刚才的任务**：切回原会话，把内容作为草稿插入输入框并聚焦（失败复制到剪贴板）。
  - **新建任务继续**：在当前工作区新建一个 Harness 任务，内容直接填进新任务输入框。
- **单选中态**：进入 DeepSeek 页时工作区会话会取消选中，不会出现两个选中状态；点工作区任务即离开 DeepSeek 页。

![DeepSeek 页（页面区域）](docs/screenshot-page.png)

## 安装

需要 DSH 桌面端（>= 0.2.1-rc.2）。

```sh
# 用 DSH 自带 CLI，以 link 方式装进 desktop profile
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add \
  "link:/path/to/dsh-deepseek-desk"
```

也可以从 GitHub 安装：

```sh
dsh plugin --profile desktop add github:zneoxlab/dsh-deepseek-desk
```

安装完成后重启 DSH（或等插件热加载），左侧栏会出现「会话」。

## 依赖与联动

- **必需**：DSH 桌面端的内嵌浏览器能力（`globalThis.dshDesktop.browser`）。
- **可选**：[`dsh-deepseek-web-login`](https://github.com/cv-superding/dsh-deepseek-web-login) —— 提供网页登录态与账号库。装了它，DeepSeek 页打开即登录；没装也能用，在页面里手动登录即可（只是侧栏会话列表读不到）。
- 插件 **Host 半** 读取 `~/.dsh/web-login/` 下当前账号，调用 DeepSeek 官方接口 `chat_session/fetch_page` 拉会话列表，再通过同源路由 `/dsh-deepseek-desk/api/sessions` 交给客户端渲染；token 只在本机请求头内使用，不落盘、不打印、不上报。

## 开发

```sh
cd dsh-deepseek-desk
npm test        # node --test，Host 映射 + 客户端槽位注册
```

文件结构：

| 文件 | 作用 |
| --- | --- |
| `client.js` | 侧栏会话列表、主区域网页页、内嵌浏览器租约、共享登录、中文强制、接力 |
| `index.js` | Host 半：读网页登录账号、拉取/置顶/删除 DeepSeek 会话列表的 API |
| `cordis.patch.yml` / `package.json` | DSH bundle 与客户端模块清单 |
| `locale/*.json` | 插件管理器中显示的名称与说明 |
| `docs/` | 截图（会话标题已打码） |

## 隐私

- 会话列表与对话内容只在本机 DSH 进程与 DeepSeek 网页之间流转。
- 删除/置顶走 DeepSeek 网页端同款接口，操作的是你自己的账号数据。
- 仓库里的截图已对个人会话标题打码。

## License

[MIT](./LICENSE)

---

<details>
<summary>English</summary>

**dsh-deepseek-desk** is a DeepSeek Harness (DSH) desktop plugin that lists your `chat.deepseek.com` conversations in the DSH sidebar and opens the full web chat in the main area. It reuses DSH's embedded-browser lease and the web session captured by `dsh-deepseek-web-login`, forces the Chinese locale, and hands conversations off to the current Harness task or a brand-new one.

</details>
