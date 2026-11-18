---
name: paper-dual
description: Diagnose and rewrite Chinese academic papers (.doc/.docx) to reduce in-document repetition and AI-style fingerprints, with lossless Word reflow. Use when the user asks to lower AIGC detection risk, reduce repetition (降重), rewrite AI-sounding paragraphs, or check which paragraphs look machine-written. Requires the paper-dual MCP tools.
description_zh: 诊断并改写中文论文 .doc/.docx，降低篇内重复与 AI 文风痕迹，并无损回填保持 Word 格式。适用于「降 AIGC 味」「降重」「这段像 AI 写的」「论文润色但保留格式」等请求。
description_en: Diagnose and rewrite Chinese academic .doc/.docx files to reduce in-document repetition and AI-style fingerprints, with lossless Word reflow.
version: "0.1.0"
---

# 论文双降（TRAE CN 版）

用一个闭环处理一篇中文论文：**诊断 → 生成定向改写任务 → 模型写 edits.jsonl → 预检 → 回填 → 复检**。
文档只在本机处理；插件不读 token、不写远端。

## 硬边界（先向用户说清）

- 输出是**篇内相对风险**与**本插件自有口径的 AI 疑似占比**，不是知网/维普/格子达的检测概率，也不承诺通过率。
- 不代写、不补数据、不编文献；改写必须逐句可追溯回原文。
- 标题、表格、代码块、公式、文本框、脚注、超链接、修订痕迹、参考文献一律不改。
- 改写后的稿子必须由作者复核后再提交。

## 工具

| 工具 | 用途 |
| --- | --- |
| `paper_dual_status` | 引擎、当前文档、版本链、待回填清单、AIGC 状态 |
| `paper_dual_diagnose` | 诊断 `.doc/.docx`，返回风险分布、重复率、Top 段落、report.md |
| `paper_dual_rewrite` | 生成 `prompts.jsonl` 与 `edits.jsonl` 路径；`mode=dedupe/aigc/both` |
| `paper_dual_apply_edits` | 预检 → 回填 → 复检（aigc/both 强制冻结块复检，失败整篇回退） |
| `paper_dual_aigc` | AIGC 考官：正文占比、档位、稳定度、块级定位 + 9 维痕迹诊断 |
| `paper_dual_recheck` | 手动复检；不通过自动回退 |
| `paper_dual_rollback` | 把当前改稿整篇回退到基础稿 |
| `paper_dual_report` | 读取 report.md / profile / verdict / result，或输出三栏对照 |
| `paper_dual_setup` | 查看环境、设置 pythonPath/engineDir/hfCacheDir、自检、标定、考官自检 |

## 标准流程

### 1. 确认环境

先调 `paper_dual_status`。引擎已内置在插件 `engine/`，正常情况下应显示「就绪」。
若显示找不到 `run.py`，让用户装 Python 3.10+，再用 `paper_dual_setup`（`action=set_config`, `pythonPath=...`）指定解释器。
`paper_dual_setup`（`action=doctor`）可跑引擎自检。

### 2. 诊断

```
paper_dual_diagnose { "path": "D:\\papers\\thesis.docx" }
```

- 只读原文件；`.doc` 会先转成副本 `.docx`。
- 返回「高/中/低」风险分布、篇内重复率、Top 段落与 `report.md` 路径。
- 需要完整报告时调用 `paper_dual_report`（`action=report`）。

### 3. 选模式并生成任务

| 用户目标 | `mode` | 说明 |
| --- | --- | --- |
| 降重 / 篇内重复 | `dedupe` | 离线可用，只按 13 字指纹找「自己抄自己」 |
| 降 AI 味 / AIGC | `aigc` | 先跑 9 维痕迹诊断，把要求注入每条提示词 |
| 两个都要 | `both` | 一次改写同时注入消重与 AIGC 要求 |

```
paper_dual_rewrite { "path": "D:\\papers\\thesis.docx", "mode": "both" }
```

- 第 3 轮起自动进入「少量高风险段落」定向续改；硬上限 5 轮。
- 可以用 `baseVersionId` 指定从原文还是上一版改稿继续。
- 若返回「任务 0 段」，说明没有达到阈值的段落，如实告诉用户，不要硬改。

### 4. 让模型改写（你自己完成这一步）

生成任务后，工具会给出 `prompts.jsonl` 与 `edits.jsonl` 的绝对路径。你必须：

1. 用 Read 读取 `prompts.jsonl`，每行一条提示词，含 `pid`、原文与要求。
2. 严格按提示词逐条改写，**只改表达层**，不改事实、数字、引用、结论强度。
3. 用 Write 写出 `edits.jsonl`，一行一条：

```json
{"pid": "p0350", "text": "改写后的整段文字", "op": "O1"}
```

4. 也可以把 JSONL 内容直接作为 `paper_dual_apply_edits` 的 `edits` 参数传入。

`edits.jsonl` 契约（违反会被逐段拒绝，不连坐）：

| 规则 | 判据 |
| --- | --- |
| 不改事实 | 数字/年份/百分比/引用/书名/缩写集合完全一致 |
| 不新增主观表述 | 「我觉得／我认为／笔者认为」计数不得增加 |
| 不改长度量级 | 字数 ∈ 原文 × [0.55, 1.40] |
| 不改格式 | 段落/字符属性签名不变 |
| 不动锁定区 | 标题、表格、代码块、公式、脚注、参考文献、<40 字段 |
| 保留加粗小标题 | 保护区内外的加粗片段原样出现 |

### 5. 预检与回填

```
paper_dual_apply_edits { "scope": "both" }
```

- `scope` 与第 3 步的 `mode` 保持一致。
- AIGC/双降模式回填后会立刻用基础稿冻结块做模型复检；正文占比上升、模型不可用或未冻结块都会判失败并**整篇回退**。
- 纯降重模式只做结构与重复率验收，不强制模型。
- 若预检有会被拒的编辑，按返回的原因修改 `edits.jsonl` 后重试。

### 6. 复检、对照与下一轮

- `paper_dual_recheck`：手动复检；给出 9 维、重复率、AI 疑似占比的前后对比。
- `paper_dual_report { "action": "compare" }`：三栏对照（原文 / 改文 / 字数句数变化）。
- 复检不通过且仍有下一轮时，用返回的 `focusPids` 作为 `paper_dual_rewrite` 的 `focusPids` 继续定向改写。
- 想放弃当前版本：`paper_dual_rollback`。
- 改稿文件路径在回填结果里（`改稿：...`），交给用户下载/复核。

## AIGC 考官（可选）

`paper_dual_aigc` 需要 `torch + transformers`；**缺依赖时插件只返回安装步骤，不会生成伪分数**。

1. `paper_dual_aigc` 的报错里会带 PowerShell 安装脚本与 venv 路径。
2. 装完用 `paper_dual_setup`（`action=set_config`）设置 `pythonPath` 和 `hfCacheDir`。
3. `paper_dual_setup`（`action=calibrate`）做方向标定；首次会联网下载约 409MB 权重。
4. `paper_dual_setup`（`action=selftest`）可跑考官离线自检。

不装模型也能用：`dedupe` 模式、9 维痕迹诊断、预检、回填与结构复检都是离线可用的。

## 结果怎么汇报

- 诊断：风险分布、重复率、Top 3–5 段落，报告路径。
- 改写任务：任务段数、提示词条数、版本号、要求用户确认再继续。
- 回填：预检通过/拒绝数、回填接受/拒绝数、复检结论、改稿路径。
- 复检：前后指标对照；未通过时明确说「已回退」，不要粉饰。
- 任何情况下都不要说「已通过知网/维普检测」。

## 常见问题

- **引擎目录里没有 run.py**：插件安装不完整，重新安装插件；或 `paper_dual_setup` 指定 `engineDir`。
- **Python 不可用**：装 3.10+，用 `paper_dual_setup` 设置 `pythonPath`（Windows 可直接填 venv 的 `Scripts\\python.exe`）。
- **edits.jsonl 全被拒**：多半是换了文档或原文件被改过；重新 `paper_dual_diagnose` 后重新生成任务。
- **复检总不通过**：先看 `paper_dual_report` 的 verdict 与失败项；降重模式不要求 AIGC 模型，双降模式要求模型可用。
- **想换一篇论文**：重新 `paper_dual_diagnose` 新路径；状态按文档哈希隔离，不会串稿。

## 参考

- `references/design.md`：完整设计与验收矩阵
- `references/operators.md`：改写算子与归因
- `references/thresholds.md`：阈值与档位口径
- `references/compliance.md`：合规边界
