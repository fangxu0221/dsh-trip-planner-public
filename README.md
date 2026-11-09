# 出行规划 · DeepSeek Harness 插件

在 Harness 会话的右栏查询高德地点、管理收藏和规划路线，同时保留左侧对话。网页和聊天工具共用收藏，改名或取消后，打开的面板会自动更新。

- 支持按城市和关键词搜索地点，从搜索结果或收藏中选择起终点。
- 支持步行、骑行、驾车和公共交通。步行可展开原始步骤，公共交通会突出来源提供的方向、下车站和出口。
- 支持收藏地点、改名和取消收藏。收藏保存在当前 Harness Home 的本地 JSON 存储里。
- 支持保存常用路线，重新规划、改名、删除，以及在收藏端点失效后重新选择。
- 对话中的路线可同步到右栏；路线结果支持展开、收起、移除和撤销。
- 对话中明确比较多种交通方式时，右栏可切换查看各方式的路线；未指定方式时，插件会引导模型先询问。

## 准备 Harness

以下命令使用 Windows PowerShell。需要 Git、Node.js 24.9 或更高版本、pnpm 11.28.5，以及高德开放平台的 MCP Key。插件使用 Harness 的构建产物和同一份协议包。请把本仓库和 Harness 克隆到同一个父目录，Harness 目录名使用 `deepseek-harness`。

从这两个目录的父目录运行：

```powershell
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout ce7073d51254c26cd63b22a60835b8f948deb447
pnpm.cmd install --frozen-lockfile
pnpm.cmd run build
cd ..
```

如果已经有这一提交的 Harness 源码和构建产物，可以直接安装插件依赖。Harness 的源码构建流程见[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/README.zh.md#run-from-source)。

## 配置和启动

在本插件目录运行：

```powershell
pnpm.cmd install --offline --ignore-scripts --frozen-lockfile
pnpm.cmd run configure
```

打开生成的本地 `cordis.yml`，把 `YOUR_AMAP_MCP_KEY` 换成自己的 Key。可同时调整 `defaultCity`。配置脚本会按当前目录填好插件入口，已有的 `cordis.yml` 由使用者编辑。把项目移动到别处时，请在本机配置中更新两个插件入口路径。Key 的申请步骤见[高德 MCP 文档](https://lbs.amap.com/api/mcp-server/gettingstarted)。

```powershell
pnpm.cmd run build:web
pnpm.cmd run start:web
```

启动脚本默认使用本机 3083 端口。使用其他端口时，可在启动前设置 `$env:TRIP_WEB_PORT = '3084'`。要手动打开浏览器，可以运行 `pnpm.cmd run start:web --no-open`，使用终端输出的本地链接。

也可以从已构建的 Harness 源码目录直接启动，把下面的路径替换为你本机配置文件的路径。

```powershell
pnpm.cmd dsh web --patch '<插件目录>/cordis.yml' --port 3083
```

## 使用教程

1. 在 Harness 中打开一个会话，展开右侧边栏，在「开始」里打开「出行规划」。
2. 点「起点」或「终点」，在弹窗里搜索地点，也可以切到「我的收藏」选用已保存的地点。搜索结果旁的「收藏」可以为地点设置别名。
3. 两端选好后，选择交通方式并点「规划路线」。公共交通会展示来源提供的线路、方向、站数、下车站和出入口。点「查看原始步行步骤」可查看完整步行指引。
4. 展开「地点收藏」管理收藏；在选点弹窗的「我的收藏」中也可以选用、改名或取消收藏。已选的收藏被改名时，端点显示会同步更新。
5. 查询路线后可保存为常用路线，在「常用路线」中重新规划、改名或删除。如果收藏端点已删除，请重新选择端点。
6. 路线结果可按方案展开、移除或撤销移除；「清空规划」清除结果并保留起终点和收藏。

如果 Harness 已配置模型，也可以在对话里试试「搜索广州塔并收藏为周末起点」，再问「从周末起点到广东省博物馆怎么坐地铁」。右栏可以直接操作地点搜索、收藏和路线查询。

也可以明确要求比较公共交通和驾车，在右栏的交通方式标签间切换。若路线需求未指定交通方式，插件会提示模型先询问；实际回复仍取决于所用模型。对话路线保存在当前进程中，重启后需要重新查询。

修改代码后，运行 `pnpm.cmd run typecheck` 检查服务端类型，再执行 `pnpm.cmd run build:web` 生成面板和协议，重启当前 Web 实例。
