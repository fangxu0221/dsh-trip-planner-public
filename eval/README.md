# Agent 自动化场景评测 V1

在 Trip Planner 仓库根目录执行。需要 Node 24.9+、pnpm、本项目已有依赖，以及相邻已构建的 `../deepseek-harness`。安装步骤只建立本地 Harness 链接，不下载模型 SDK：

```powershell
pnpm.cmd --dir eval install --offline --ignore-scripts --frozen-lockfile
pnpm.cmd --dir eval run typecheck
pnpm.cmd --dir eval run agent -- --list
pnpm.cmd --dir eval test
```

真实模式从当前 PowerShell 进程读取已有的 `DEEPSEEK_API_KEY`。默认使用官方 HTTPS Messages 端点与当前 Harness 内置的 `deepseek-flash`；如使用自己的兼容端点，可在启动环境中设置 `DEEPSEEK_BASE_URL`。无需修改 `cordis.yml`、安装地图 MCP 或提供高德 Key。

```powershell
# 首次仅自动选择 005、012、015 各一次
pnpm.cmd --dir eval run agent -- --smoke
pnpm.cmd --dir eval run agent -- --id AGENT-005
pnpm.cmd --dir eval run agent -- --tag transit
pnpm.cmd --dir eval run agent -- --id AGENT-018 --repeat 3
# 确认 Smoke 及 Trace 后，按需明确选择整套（29 题 × 所选重复次数）
pnpm.cmd --dir eval run agent -- --all --repeat 3
```

默认关闭 thinking，向支持的 Messages 模型发送 `temperature=0`；可用 `--model`、`--temperature default` 或 `--temperature 0.2` 等参数切换。每次模型请求后台输出上限默认 1200 token；每场默认 12 次模型请求、18 次模型根工具调用、90 秒；整次运行默认 30 分钟。可通过 `--max-tokens`、`--max-model-calls`、`--max-tool-calls`、`--timeout-ms`、`--run-timeout-ms` 调整。模型请求不自动重试；连接或适配器异常会中断后续付费请求。

不需要模型 API 的离线报告：

```powershell
$env:TRIP_EVAL_OFFLINE_REPORT = '1'
pnpm.cmd --dir eval test
Remove-Item Env:TRIP_EVAL_OFFLINE_REPORT
```

离线测试以编写好的参考动作直接调用生产工具流水线，逐条校验 29 个场景可达，同时测试评分器能识别错误草稿、绕过、超时、虚构事实及缺失轮次。它标注为 `offline_fixture`，没有模型决策过程。真实模式使用 `real_agent`。

场景是 [agent_v1.jsonl](scenarios/agent_v1.jsonl)。`expected.calls` 按轮匹配业务工具、参数子集和结构化结果，允许声明多种合格值；`draftFrom` 指向同 Session 早先的推荐轮，`selection` 可比较编号、将地点名映射成实际编号、接受当前草稿中代选的编号，或检查续查只传 `draftId`。`forbidden` 声明提前规划、重复查地图或使用旧清单等禁止行为；`expected.manual` 保留无法可靠自动评分的内容。报告通过率只表示硬规则通过率；基础设施和 Fixture 故障单列为不可评分。

结果写在 `eval/reports/<运行时间>/`：`summary.json` 汇总；`cases.jsonl` 记录每场评分、证据和人工项；`traces/` 保存逐轮回复、根工具与内部工具的参数和结果、实际 Fake 工具体及各自时间；`report.md` 汇总并链接失败 Trace。重复根调用与重复实际地图请求分开统计；缓存命中读取生产计数器；预算拒绝读取内部流水线结果。Trace 只保存合成业务数据和模型错误编码，不导出请求头、模型请求正文或完整系统提示词。退出码 0 = 通过，1 = 硬规则失败，2 = 配置或运行异常。评测源码、场景与模拟数据随仓库发布。生成报告和 Trace 保存在本机。
