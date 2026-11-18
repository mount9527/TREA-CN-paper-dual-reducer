# trae-paper-dual · 论文双降（TRAE CN 插件）

把中文论文的**篇内重复**与**AI 文风痕迹**诊断、定向改写、无损回填，做成 TRAE CN 里的一个 Skill + MCP 工具集。

本仓库是从 DSH 插件 [`mount9527/paper-dual-reducer`](https://github.com/mount9527/paper-dual-reducer) **重新开发**的 TRAE CN 版本，不是替换原仓库：

- 原版依赖 DSH 宿主，提供侧栏 Web 面板；TRAE CN 插件没有面板能力，因此把七步面板流程收敛为 **Skill 引导 + 9 个 MCP 工具**。
- Python 引擎（`run.py` / `scripts/` / `lib/`）已**内置**，装完插件不需要再单独下载引擎。
- AIGC 考官脚本内置；`torch + transformers` 仍需用户按需安装，缺依赖时不会生成伪分数。
- 文档只在本机处理，不上传、不追踪。

## 能力

| 模式 | 关注 | 验收 |
| --- | --- | --- |
| `dedupe` 降重 | 13 字指纹找「自己抄自己」 | 篇内重复率前后对比（离线） |
| `aigc` 降 AI 味 | 9 维痕迹诊断 → 注入提示词 → 改写 | 风险项/语体门禁（离线）+ AI 疑似占比/档位/稳定度（需模型） |
| `both` 双降 | 一次改写同时注入消重与 AIGC 要求 | 两边分别报告 |

每个模式共用同一条流水线：

```
诊断 → 生成 prompts.jsonl → 模型写 edits.jsonl → 预检 → 回填 → 复检
```

- 版本链：`原文 / 改稿 / 二改 / 三改…`，最多五改。
- AIGC/双降回填后强制用基础稿冻结块复检；指标恶化、模型不可用或未冻结块时整篇回退。
- 标题、表格、代码块、公式、脚注、参考文献一律不改。

## 安装

插件走 TRAE CN 插件机制：`.trae-plugin/plugin.json` + `.mcp.json` + `skills/`。

在 TRAE CN 的插件管理中安装本仓库（开发时可把仓库根目录作为本地插件目录导入）。安装后应能看到：

- Skill：`paper-dual`（论文双降）
- MCP 服务：`paper-dual`
- 工具：`paper_dual_status` / `diagnose` / `rewrite` / `apply_edits` / `aigc` / `recheck` / `rollback` / `report` / `setup`

## 依赖

- **Node.js 20+**：TRAE CN 自带，用于运行 MCP 服务。
- **Python 3.10+**：引擎零第三方依赖；`.doc` 转换在 Windows 上优先用 Word COM，失败再试 LibreOffice。
- **可选：`torch + transformers`**：只有 AIGC 考官需要。缺依赖时插件返回安装脚本与配置步骤。

Python 解释器默认使用 PATH 上的 `python`。如需指定 venv：

```text
paper_dual_setup { "action": "set_config", "pythonPath": "D:\\venvs\\paper-dual\\Scripts\\python.exe" }
```

## 快速开始

1. 在对话里说：「帮我诊断这篇论文的 AI 味和重复率，路径是 `D:\papers\thesis.docx`」。
2. Agent 调 `paper_dual_diagnose`，给出风险分布、重复率与 Top 段落。
3. 选择模式后调 `paper_dual_rewrite`，拿到 `prompts.jsonl`。
4. Agent 读取提示词、逐条改写，写出 `edits.jsonl`。
5. 调 `paper_dual_apply_edits` 完成预检、回填与复检。
6. 用 `paper_dual_report` 查看报告或三栏对照，改稿 docx 路径在回填结果里。

## 工具

| 工具 | 说明 |
| --- | --- |
| `paper_dual_status` | 引擎、当前文档、版本链、待回填清单、AIGC 状态 |
| `paper_dual_diagnose` | 诊断 `.doc/.docx`，只读 |
| `paper_dual_rewrite` | 生成改写任务；`mode=dedupe/aigc/both` |
| `paper_dual_apply_edits` | 写入清单 → 预检 → 回填 → 复检 |
| `paper_dual_aigc` | AI 疑似占比、档位、稳定度、块级定位 + 9 维诊断 |
| `paper_dual_recheck` | 手动复检；失败自动回退 |
| `paper_dual_rollback` | 当前改稿整篇回退 |
| `paper_dual_report` | 报告 / profile / verdict / result / 三栏对照 |
| `paper_dual_setup` | 环境、配置、引擎自检、方向标定、考官自检 |

## 状态与配置

默认状态目录：`~/.trae-cn/paper-dual/`

- `state.json`：最近 12 篇文档各自的任务、回填、复检与 AIGC 结果
- `docs/<文件名>-<哈希>/`：按文档隔离的产物
- `archive/`：重新诊断同一路径时移入的旧产物

可用环境变量覆盖：

| 变量 | 作用 |
| --- | --- |
| `PAPER_DUAL_STATE_DIR` | 状态目录 |
| `PAPER_DUAL_ENGINE` | 引擎目录（默认插件内置 `engine/`） |
| `PAPER_DUAL_PYTHON` | Python 解释器（也可用 `paper_dual_setup` 写入配置） |
| `PAPER_DUAL_AIGC_HOME` | AIGC venv/模型缓存默认根目录 |

## 边界

- 风险分是**篇内相对指标**，只用于同篇排序，跨文档不可比。
- AIGC 考官给的是本工具自有口径下的「正文 AI 疑似占比」，不等于任何平台判定，也不与第三方平台横比。
- 不模拟任何平台，不承诺通过率。
- 改稿必须由作者复核。

## 开发与自测

```bash
node --check mcp/core.js
node --check mcp/server.mjs
node tests/smoke.mjs
```

`tests/smoke.mjs` 会：启动 MCP 服务 → `initialize` → `tools/list` → 用内置 `engine/tests/fixtures/sample.docx` 跑 `paper_dual_diagnose` → 检查 `paper_dual_aigc` 缺依赖分支。

## 许可

- 插件代码：MIT（见 `LICENSE`）
- 内置引擎：MIT，来自 [`mount9527/skill-paper-dual-reducer`](https://github.com/mount9527/skill-paper-dual-reducer)
- AIGC 检测模型 `yuchuantian/AIGC_detector_zhv3`：Apache-2.0，**不随本仓库分发**；权重由使用者首次标定时从 HuggingFace 下载
- 详细第三方说明见 `THIRD-PARTY-NOTICES.txt`
