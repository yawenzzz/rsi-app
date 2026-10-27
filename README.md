# RSI — 独立 DSH 应用插件

RSI 是一个独立维护、独立打包的 DSH 插件。项目 Agent、四阶段认知流程、能力包、执行证据和人工评价都在本仓库；DSH 运行时来自官方 npm 发布包，不需要克隆、编译或修改 DSH 源码。

当前包名为 `@yawenzzz/dsh-rsi`，版本为 `0.1.0`，适配官方 DSH `0.2.1-rc.3`。源码和预构建安装包通过 [GitHub](https://github.com/yawenzzz/rsi-app) 发布；尚未发布到 npm registry。

## 通过 DSH 安装

已有 Web profile 时，可直接安装 GitHub Release 的预构建包，无需下载源码、编译插件或登录 npm：

```sh
dsh plugin --profile xxx add https://github.com/yawenzzz/rsi-app/releases/download/v0.1.0/yawenzzz-dsh-rsi-0.1.0.tgz
dsh --profile xxx --port 3081
```

`xxx` 替换为你的 profile 名，`dsh --version` 应为 `0.2.1-rc.3`。首次创建一个新的 Web profile 时，在安装前执行下面的初始化命令；不要对已有 profile 执行，它会重置其组合：

```sh
dsh --profile xxx --from-default-profile web --dump-config
```

没有全局 DSH 时，可使用官方 npx 入口：

```sh
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh --profile rsi --from-default-profile web --dump-config
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh plugin --profile rsi add https://github.com/yawenzzz/rsi-app/releases/download/v0.1.0/yawenzzz-dsh-rsi-0.1.0.tgz
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh --profile rsi --port 3081
```

安装入口使用 Release 的 `.tgz`，不是 GitHub 自动生成的源码压缩包。前者包含已构建的 Host 和 Client 产物。

从旧 RSI fork 迁移时，请使用新的 profile 或独立的 `DSH_HOME`，不要在同一 profile 同时加载新旧 RSI 应用包。已有项目通过下文的导入工具预检后迁移。

## 从独立仓库运行

需要 Node.js 24.9+、npm，以及 DSH 插件安装命令使用的 pnpm。

```sh
npm ci
npm run build
npm run setup
npm start -- --port 3081
```

`setup` 使用官方 DSH CLI 创建独立 Web profile 并安装构建后的 RSI tarball。默认数据目录为 `~/.rsi-standalone`，profile 名为 `rsi`，不改原有 `~/.rsi`、`test4` 或 `test5`。已经存在的 profile 不会被初始化命令重置。安装后从原生侧栏打开“RSI 项目”，创建或进入项目；模型和凭据仍在原生 DSH 设置页配置。

也可以选择其他数据目录和 profile：

```sh
npm run setup -- --home /absolute/path/to/rsi-home --profile research
npm start -- --home /absolute/path/to/rsi-home --profile research --port 3081
```

## 无源码安装

先构建并生成发布包：

```sh
npm run build
npm pack --ignore-scripts
```

把生成的 `.tgz` 交给另一台只有 Node.js、npm 和 pnpm 的机器。以下命令使用官方运行时；初始化步骤只对新 profile 执行：

```sh
export DSH_HOME="$HOME/.rsi-standalone"
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh --profile rsi --from-default-profile web --dump-config
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh plugin --profile rsi add /absolute/path/to/yawenzzz-dsh-rsi-0.1.0.tgz
npx --yes --package=@deepseek-ai/dsh@0.2.1-rc.3 dsh --profile rsi --port 3081
```

GitHub Release 地址与本地 tarball 使用相同的安装机制。npx 会缓存官方运行时和依赖；“无源码安装”并不意味着机器上不存在运行时文件。

Profile 的三个组合层是官方 `dsh-base`、官方 `dsh-web-app` 和本包。一个对外安装包包含管理端、项目 Agent 入口、客户端页面和可选模拟研究模块；内部模块不需要用户分别安装。

## 项目与设置

- 每个项目保留自己的 `profile/`、`plugins/`、`bundles/`、`workspace/` 和 `.rsi/`。
- 设置与插件管理可写，保存到该项目的 `profile/`。上下文预算等实时配置通过官方 Loader 生效，重启后保留。
- 新项目继承当前模型提供方的完整公开配置，包括模型目录、覆盖值与上下文设置。凭据保存引用，不写入 profile。
- 项目进程使用同一套官方 DSH 安装。各项目使用独立、持久化的本地端口；浏览器存储和认证按 origin 隔离。端口被占用时启动报错，不会悄悄换端口。
- 项目管理和工作流使用 RSI 自己的公开 slot 扩展面板。没有修改官方工作区侧栏、会话组件或浏览器存储实现。
- 子页面“前往主应用更新”返回管理端，再执行空闲重启；不会让子进程在回复请求前终止自己。
- `Clarify → Self-evaluation → Repair → Execute`、认知版本、执行证据和人工验收规则保留。模型工具不能写入人工评分。

独立进程和数据目录不是容器安全隔离。插件仍以宿主用户权限执行，工具访问遵守官方 DSH 的沙箱和审批策略。

## 导入已有 RSI 项目

先完成新应用的 `setup`，再从本仓库运行预检：

```sh
node scripts/import-project.mjs --project /absolute/path/to/project --json
```

预检不会写文件。确认项目进程已经停止、插件声明兼容后，显式应用迁移：

```sh
node scripts/import-project.mjs --project /absolute/path/to/project --apply
```

工具只备份并修改项目的两份源 profile 文件，保留 identity、Session 和认知日志的原始字节；备份位于项目 `.rsi/import-backups/`。迁移后在新应用的“RSI 项目”中添加原目录。存在 writer lock、不兼容插件、旧 `.poly-rsi` 数据或需要人工适配的自定义覆盖时会拒绝写入；不会停止进程、升级插件或添加兼容性豁免。`--home` 和 `--profile` 可指定新应用的位置。

迁移工具验证声明范围，不替代真实插件运行验收。旧项目的浏览器草稿和界面偏好不迁入新的独立 origin，磁盘上的会话历史保持原样。

## 可选模拟研究

Polymarket 数据、策略评估、模拟账本和发布检查模块保留在 `src/runtime/`。默认应用不加载市场采集，也不执行真实资金交易。需要时在 profile 中加入本包的 `bundles/paper.patch.yml`；其默认采集与研究均关闭，资金为模拟值。自定义发布检查必须针对你自己的代码仓库配置，不能依赖 DSH 源码目录。

## 开发和验收

```sh
npm run typecheck
npm run build
npm test
npm run test:integration
npm run check:standalone
npm run test:smoke
```

单元测试使用公开 npm 类型和本地测试双。进程测试使用真实官方 CLI、独立临时 home 和本地模型 fixture，不调用付费模型。打包 smoke 将 tarball 安装到干净目录，验证主应用、两个独立项目、真实工具执行、设置修改及重启持久化；它不从开发 checkout 解析运行时代码。

`scripts/check-standalone.mjs` 拒绝本地路径依赖、旧 fork 包和非官方扩展点。升级流程见 [docs/UPGRADING.md](docs/UPGRADING.md)。旧项目导入须先预检和备份，不应直接切换正在运行的旧部署。

## 目录

```text
src/index.ts       应用角色与官方插件入口
src/harness/       项目目录、进程、配置、认知和人工评价
src/agent/         项目 Agent 工具与执行证据
src/client/        RSI 项目面板与任务工作流
src/runtime/       可选市场研究和模拟账户
src/shared/        自有 JSON 工具输出、RPC 和固定流程指令
bundles/           应用、项目与可选研究 patch
scripts/           构建、安装、启动与独立性检查
tests/             单元、客户端和原生进程验证
```

本项目使用 MIT 许可证，并保留 DSH/Cordis 的归属说明。运行时依赖的许可与安全更新由各自发行方维护；不要通过修改 `node_modules` 来兼容新版本。
