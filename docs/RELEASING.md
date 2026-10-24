# dsh-web-chat 发布步骤

1. 确认版权与来源说明保留、维护者信息正确，检查当前 npm 名称归属及发布权限。检查时未发现公开同名包不代表名称已保留。
2. 运行 `npm ci`、`npm run release:check`，检查 `npm pack --dry-run --json` 文件清单；不得包含账号快照、历史截图或内部计划。
3. 运行 `npm pack`，用生成的安装包在 Harness 中验证安装、登录迁移、分组、40/60 布局、首次打开和草稿交接。分别验证 macOS 和 Windows；未验证的平台不要声明已验证。
4. 在维护者确认后提交版本、推送源码并执行 `npm publish`。本次整理不执行这些外部发布操作。
5. 确认注册表可读取该版本后运行 `npm run market:update`，它只使用与包名、版本、仓库及 DSH 元数据匹配的真实发布记录生成索引。未发布时保留空索引，不展示虚假的可安装版本。
6. 提交生成的市场索引后，再向用户提供真实市场地址。

本地源码目录仍为 dsh-deepseek-webdesk，GitHub 仓库已改名为 dsh-web-chat；包名和界面名称均为 dsh-web-chat。
