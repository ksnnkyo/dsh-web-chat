# dsh-web-chat 发布步骤

1. 确认版权与来源说明保留、维护者信息正确。
2. npm 发布前，检查 npm 名称归属及发布权限。检查时未发现公开同名包不代表名称已保留。
3. npm 发布前运行 `npm ci`、`npm run release:check`，检查 `npm pack --dry-run --json` 文件清单；不得包含账号快照、历史截图或内部计划。再运行 `npm pack`，用安装包验证 Harness 安装、登录迁移、分组、布局、首次打开和草稿交接。分别验证 macOS 和 Windows；未验证的平台不要声明已验证。
4. GitHub 源码版本：更新版本号与变更记录，提交并推送源码，创建对应的版本标签和 GitHub Release。该流程不会发布 npm 包。
5. npm 发布：仅在维护者明确决定发布后执行 `npm publish`。
6. 确认注册表可读取该版本后运行 `npm run market:update`，它只使用与包名、版本、仓库及 DSH 元数据匹配的真实发布记录生成索引。未发布时保留空索引，不展示虚假的可安装版本。
7. 提交生成的市场索引后，再向用户提供真实市场地址。

本地源码目录仍为 dsh-deepseek-webdesk，GitHub 仓库已改名为 dsh-web-chat；包名和界面名称均为 dsh-web-chat。
