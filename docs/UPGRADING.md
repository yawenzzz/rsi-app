# DSH 升级与 RSI 发布

RSI 只维护自己的 npm 包。官方 DSH 通过固定版本依赖接入；本仓库没有 DSH 的 Git 上游合并流程，也没有运行时补丁目录。

## 升级 DSH

1. 创建 RSI 升级分支，确认目标版本已发布到 npm。官方 Git master 与同版本号的已发布 tarball 可能包含不同接口，以发布包为准。
2. 更新 `package.json` 中 `@deepseek-ai/dsh`、所用 DSH 服务包版本以及 `engines.dsh`，重新生成锁文件。Cordis 等独立版本包使用该官方运行时声明的版本范围。
3. 只在 RSI 自己的代码中适配公开接口变化。不能补导出到官方包，不能引用上游 `src/`、开发工作区或私有测试文件。
4. 执行 typecheck、单元测试、构建和原生进程测试。特别检查模型切换与上下文、可编辑设置、不同项目隔离、会话和认知记录恢复。
5. 执行 `npm run check:standalone` 和 `npm run test:smoke`。最后一项必须安装真实 tarball，而非链接开发目录。
6. 在临时或测试项目验收后更新正式部署。先备份状态，确认新运行时对已有 Session 格式的支持；软件包降级不保证能读取升级后的数据。

## 发布 RSI 到 GitHub

1. 修改本包版本，更新变更说明和明确的 DSH 兼容范围。
2. 构建后运行 `npm pack --dry-run`，确认只包含构建产物、bundle、locale、文档和许可证，没有账号信息、项目数据、测试产物或上游源码。
3. 用打包 smoke 检查相同 tarball。
4. 提交源码，创建与包版本一致的 `v<version>` 标签，将构建后的 `.tgz` 与 SHA-256 校验文件上传到对应 GitHub Release。不要把 GitHub 自动生成的源码压缩包当作插件安装包。
5. 执行 `npm run test:smoke -- --release-url <公开的Release安装包URL>`，通过官方 `dsh plugin --profile rsi add` 从远程地址安装并验证同一发布版本。

GitHub 发布不依赖 npm 登录。如需另外发布到 npm registry，须先确认 scope 所有权和登录状态。

Codex 订阅等第三方插件单独声明版本兼容。升级 DSH 前应一并检查；不会为其自动添加风险豁免或改写安装包。

## 架构约束

- 官方 DSH、Cordis、React 和共享 Client 模块保持宿主提供的运行时身份，不能作为另一套框架嵌入插件。
- 通用工具输出与 RSI 业务规则属于本包，不能为一个辅助函数修改上游公开导出。
- 模型继承通过公开 provider directory、Settings、LLM 和凭据 API；不复制上游提供方解析器。
- 原生 DSH 的浏览器存储按 origin 工作。每个 Agent 复用自己持久化的端口，RSI 不替换 `localStorage` 或官方状态管理模块。
- 请求通过官方认证 Fetch 注册接口。模型控制与人工评价的入口分开，所有外部参数在进入操作前校验。
