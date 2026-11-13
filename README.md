# 临时快照清理（dsh-temp-snapshot-cleanup）
DSH内置插件会为每个会话建立一个临时 git 对象目录，用来做轮次前后的文件对比，文件放在用户目录AppData\Local\Temp下。这类目录只在 Session 正常释放时才删；DSH 被强杀、崩溃，或者会话一直开着没释放，目录就会留下，占用c盘空间；文件大小具会话长度0~3gb不等，DSH 重启后这些快照目录就是纯垃圾了，删了不损失任何东西。

该插件会回收内置插件 `@deepseek-ai/dsh-workspace-changes` 遗留的临时快照目录所占据的磁盘空间。
为每个 Session 在系统临时目录下建一个 `dsh-workspace-changes-<6位串>` 目录，用来存放轮次对比所需的 git 对象；Session 正常释放时会删除它。DSH 被强杀、崩溃或会话未释放时，这些目录会残留，单个通常 0.5–2.5 GB。本插件在 Host 启动约 5 秒后扫描一次临时目录，只删除**能够证明已无主**的目录，其余一律跳过。

## 安装

需要先有 DSH（桌面版或 CLI）。

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:Parettia/dsh-temp-snapshot-cleanup

# 本地开发：直接指向本目录
dsh plugin --profile web add link:/绝对路径/dsh-temp-snapshot-cleanup
```

装好后重启 DSH，「插件」页里会出现「临时快照清理」。默认 `dryRun: true`，只出报告不删除，先看一轮候选再决定是否关闭。

## 行为

1. 读取配置（`enabled` 为 `false` 时直接不做任何事）。
2. 等待 `startupDelayMs`（默认 5000 毫秒）。
3. 扫描临时目录的**直属子级**，逐项判定（见下一节）。
4. `dryRun: true`（默认）：逐个记录候选目录的路径、大小、创建时间，并输出汇总，不删除任何东西。
5. `dryRun: false`：按创建时间从早到晚删除，最多 `maxDirsPerRun` 个，输出 `removed N dirs, freed X MB (skipped M)`。
6. `intervalHours > 0` 时，之后每 `intervalHours` 小时重复一次；默认 `0` 表示每次 Host 启动只跑一次。

单个目录删除失败只写 `warn`，不中断、不弹窗、不影响其他目录；整轮流程包在 `try/catch` 中，异常同样只写 `warn`。

## 安全规则

只有同时满足下列全部条件的目录才会被删除：

| # | 条件 |
|---|---|
| 1 | 位于临时目录（`os.tmpdir()`，或 `tempRoot`）的**直属子级**，不递归、不跨盘 |
| 2 | 名称完全匹配 `^dsh-workspace-changes-[A-Za-z0-9]{6}$` |
| 3 | 是真实目录：`lstat` 显示为目录、不是符号链接 / junction / reparse point，且 `realpath` 与自身路径一致 |
| 4 | 内含 `objects` 子目录（快照指纹），且它本身也不是链接 |
| 5 | 创建时间、元数据变更时间、最后写入时间**都**早于本 Host 进程启动时间 60 秒以上 |
| 6 | 年龄 ≥ `minAgeHours`（默认 24 小时） |
| 7 | 每次运行最多处理 `maxDirsPerRun` 个（默认 20） |

其中第 5 条是核心保证：本进程启动之后被动过的目录一定属于当前 Host，天然被排除，不需要猜测哪个会话还在跑。最后访问时间被刻意忽略——仅仅列目录就会更新它，否则一次只读巡检就会把候选一直往后推。

明确不做的事：不删临时目录里的其他任何东西（`l2d-*`、安装包等一律不动），不碰 `~/.dsh`（`tempRoot` 若落在 `DSH_HOME` 或 `~/.dsh` 内会直接拒绝运行），不改 `@deepseek-ai/dsh-workspace-changes` 及其配置，不通过 shell 执行 `rm`/`del`，不跟随任何链接。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `true` | 只报告不删除 |
| `minAgeHours` | `24` | 最小年龄（小时） |
| `maxDirsPerRun` | `20` | 单次处理上限 |
| `intervalHours` | `0` | 0 = 仅在启动时执行一次 |
| `startupDelayMs` | `5000` | 激活后延迟多久开始 |
| `tempRoot` | `''` | 为空表示系统临时目录；一般只在测试时改 |

在「插件」页的本插件设置里修改，或编辑 profile 的 `cordis.patch.yml` 中 `temp-snapshot-cleanup` 这一行的 `config`（该行会整体替换默认值，所以每个字段都要写全）。

## 首次使用

1. 保持 `dryRun: true` 启动，查看日志里列出的候选目录与合计大小。
2. 确认无误后把 `dryRun` 改为 `false`。
3. 完全退出 DSH（确认没有 `DeepSeek Harness` 进程）再启动，日志应显示 `removed N dirs, freed X MB`。
4. 再次启动应显示 `no orphaned snapshot directories`。

`minAgeHours` 决定下一轮能回收多少：比 Host 启动早、但年龄不足 24 小时的目录（例如今天早些时候遗留的会话目录）要等过了 24 小时才会被删。想在下一次重启就全部回收，可以把 `minAgeHours` 调到 `1`——第 5 条规则已经保证「本进程启动后被动过」的目录绝不会被删。

日志位置：桌面版把 Host 的标准输出交给 Electron 主进程，从资源管理器启动时不落盘（只有崩溃报告会写到 `%APPDATA%\@deepseek-ai\dsh-desktop\logs`）。想看到报告，可以从终端启动 DSH 的可执行文件（安装目录下的 `DeepSeek Harness.exe`），输出会显示在该终端；或者先跑下面的自检脚本，它以同样的判定逻辑扫描真实临时目录并打印候选。

跳过原因只在 `debug` 级别输出，汇总与删除结果在 `info` 级别。

## 自检

`lib/scan.js` 只依赖 Node 内置模块，可以脱离 Host 单独跑：

```sh
node test/selftest.mjs
```

它只读地扫描真实临时目录（打印候选与跳过原因），随后在自己的 `dsh-cleanup-selftest-*` 临时目录里构造各种反例（缺 `objects`、名称差一位、同名文件、junction 链接、过新、过年轻），逐条验证判定与删除行为，最后清理掉这些构造物。

`index.js` 本身也可以在替身上下文里跑通（Config 校验 + 定时 + 扫描 + 日志），但需要 `@deepseek-ai/schemastery`；在 Host 里由 profile 的 peer 解析提供。

## 卸载

在「插件」页禁用或移除本插件即可；插件不写任何自身状态，禁用后立刻不再运行。

## 许可证

[MIT](LICENSE)
