// trae-paper-dual · MCP stdio 服务
// 把原 DSH 面板的七步流程收敛为工具：状态 / 诊断 / 生成任务 / 预检回填 / AIGC 考官 /
// 复检 / 回退 / 报告 / 配置。只使用 Node 内置模块，不引入第三方依赖。
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as core from './core.js';

const SERVER_INFO = { name: 'trae-paper-dual', version: core.VERSION };
const DEFAULT_PROTOCOL = '2024-11-05';

const pct = (v) => `${(100 * Number(v || 0)).toFixed(1)}%`;

function text(value) {
  return [{ type: 'text', text: String(value ?? '') }];
}
function fail(value) {
  return { content: text(value), isError: true };
}
function ok(value) {
  return { content: text(value) };
}

function statusText() {
  const s = core.status();
  const lines = [
    `引擎：${s.engineDir}${s.engineReady ? '（就绪）' : '（找不到 run.py）'}`,
    s.lastRun ? `最近诊断：${s.lastRun.title || s.lastRun.docPath} @ ${s.lastRun.at}` : '最近诊断：无',
    `当前版本：${s.activeVersion?.label || '原文'}（${s.activeVersionId}）`
      + `${s.baseVersionLabel ? `，基础：${s.baseVersionLabel}` : ''}；共 ${s.versionCount} 个标签`,
    `版本上限：最多五改；${s.canCreateVersion ? '还可继续生成下一版' : '已达到上限'}`,
    `已保存 ${s.runCount} 篇运行记录；原文${s.docChanged ? '已变化，需要重新诊断' : '未变化'}`,
    s.lastTasks ? `改写任务：${s.lastTasks.tasks} 段 / ${s.lastTasks.prompts} 条提示词` : '改写任务：未生成',
    s.hasEdits ? '编辑清单：已存在' : '编辑清单：无',
    `复检：${core.verdictLine(s.lastApply?.verdict)}`,
    `AIGC：${s.aigc?.detectorReady ? '真机就绪' : '未安装 torch/transformers'}`
      + `${s.aigc?.last ? ` ｜ 最近 ${s.aigc.last.target}：${pct(s.aigc.last.aiShare ?? s.aigc.last.aiProb)}` : ''}`,
  ];
  if (Array.isArray(s.versions) && s.versions.length) {
    lines.push('版本链：');
    for (const v of s.versions) {
      lines.push(`  ${v.id} ${v.label} ｜ ${v.status}`
        + `${v.baseLabel ? ` ｜ 基础 ${v.baseLabel}` : ''}`
        + `${v.downloadable ? ' ｜ 可下载' : ''}`
        + `${v.passed === true ? ' ｜ 已通过' : v.passed === false ? ' ｜ 未通过' : ''}`);
    }
  }
  return lines.join('\n');
}

const tools = [
  {
    name: 'paper_dual_status',
    description: '论文双降状态：引擎目录、当前文档与版本链、是否有待回填清单、AIGC 考官是否可用。只读。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async handler() {
      return ok(statusText());
    },
  },
  {
    name: 'paper_dual_diagnose',
    description: '诊断一篇中文论文 .doc/.docx：跑内置引擎的 diagnose，返回风险分布、篇内重复率、Top 风险段落与 report.md 路径。只读，不修改原文件。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: '论文 .doc 或 .docx 的绝对路径' },
      },
    },
    async handler(args) {
      const r = await core.diagnose(String(args?.path ?? ''));
      if (!r.ok) return fail(`诊断失败：${r.error}${r.hint ? `（${r.hint}）` : ''}`);
      const d = r.summary?.dist ?? {};
      const top = (r.summary?.top ?? []).slice(0, 5)
        .map((x) => `  ${x.pid} 风险 ${Number(x.risk).toFixed(2)} ｜ ${x.cause} ｜ ${x.chars} 字`)
        .join('\n');
      return ok([
        `诊断完成：${r.docPath}`,
        `风险分布 高/中/低：${d.high ?? 0}/${d.mid ?? 0}/${d.low ?? 0}`,
        `篇内重复率：${(100 * Number(r.summary?.repeatRate ?? 0)).toFixed(1)}%`,
        'Top 段落：',
        top || '  （无可改写段落）',
        `报告：${join(r.outdir, 'report.md')}`,
      ].join('\n'));
    },
  },
  {
    name: 'paper_dual_rewrite',
    description: '生成改写任务与 prompts.jsonl。mode=dedupe 只做篇内降重；aigc 先跑 9 维痕迹诊断并把要求注入每条提示词；both 同时注入消重与 AIGC 要求。'
      + '生成后由模型读取 prompts.jsonl、写出 edits.jsonl，再调用 paper_dual_apply_edits。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '可选的 .doc/.docx 路径；省略则用最近一次诊断的文档' },
        mode: {
          type: 'string',
          enum: ['dedupe', 'aigc', 'both'],
          description: 'dedupe=降篇内重复（离线）；aigc=降 AI 疑似占比；both=双降。默认 dedupe',
        },
        baseVersionId: { type: 'string', description: '可选的基础版本，例如 original、v1、v2' },
        maxTasks: { type: 'integer', description: '本轮改写任务上限；不填按轮次自动收敛' },
        focusPids: {
          type: 'array',
          items: { type: 'string' },
          description: 'aigc/both 模式下强制纳入的段落 id（来自 AIGC 块级定位或 9 维诊断）',
        },
        maxRounds: { type: 'integer', description: '总轮次上限，默认 5' },
        useDetector: { type: 'boolean', description: 'aigc/both 模式是否用真机考官选段；缺依赖时自动跳过' },
      },
    },
    async handler(args) {
      const mode = args?.mode ?? 'dedupe';
      const r = mode === 'dedupe'
        ? await core.runRewrite(args?.path ? String(args.path) : '', {
          baseVersionId: args?.baseVersionId,
          maxTasks: args?.maxTasks,
        })
        : await core.reducePlan({
          scope: mode === 'both' ? 'both' : 'aigc',
          baseVersionId: args?.baseVersionId,
          maxTasks: args?.maxTasks,
          focusPids: args?.focusPids,
          maxRounds: args?.maxRounds,
          useDetector: args?.useDetector,
        });
      if (!r.ok) return fail(`生成改写任务失败：${r.error}${r.limitReached ? '（已达到五改上限）' : ''}`);
      const head = [
        `任务 ${r.tasks ?? 0} 段 ｜ 提示词 ${r.prompts ?? 0} 条 ｜ 文风 ${r.textStyle ?? 'plain'}`,
        `版本：${r.baseVersionLabel || '原文'} → ${r.versionLabel || '新改稿'}（${r.versionId || '?'}）`,
      ];
      if (r.scope) head.push(`模式：${r.scope === 'both' ? '双降' : '降 AIGC'}${r.round ? ` ｜ 第 ${r.round} 轮` : ''}`);
      if (r.belowThreshold) head.push('注意：全文没有段落达到风险阈值，已按相对排序取前几段');
      if (r.detectorError) head.push(`考官选段不可用：${r.detectorError}`);
      if (r.repeatBefore != null) head.push(`篇内重复率基线：${(100 * Number(r.repeatBefore)).toFixed(1)}%`);
      if (r.hints?.length) {
        head.push('痕迹要求：', ...r.hints.map((h) => `  · ${h}`));
      }
      return ok([
        ...head,
        `提示词：${r.promptsPath || ''}`,
        `编辑清单：${r.editsPath || ''}`,
        '',
        r.instruction || '',
      ].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'paper_dual_apply_edits',
    description: '写入 edits.jsonl → 预检 → 回填 → 复检。scope=aigc/both 时强制做冻结块 AIGC 复检，不过则整篇回退；scope=dedupe 只做结构与重复率验收。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        edits: { type: 'string', description: 'edits.jsonl 的内容（多行 JSONL）。省略则读取当前版本目录里的 edits.jsonl' },
        scope: {
          type: 'string',
          enum: ['dedupe', 'aigc', 'both'],
          description: '验收口径；默认 aigc',
        },
      },
    },
    async handler(args) {
      const r = await core.runApply({ edits: args?.edits, scope: args?.scope });
      if (!r.ok) return fail(`回填失败：${r.error}`);
      const c = r.apply ?? {};
      const lint = r.lint ?? {};
      return ok([
        `版本：${r.baseVersionLabel || '原文'} → ${r.versionLabel || '新改稿'}（${r.versionId || '?'}）`,
        `预检：可通过 ${lint.would_apply ?? '?'} ｜ 会被拒 ${lint.would_reject ?? '?'}`,
        `回填：提交 ${c.edits ?? '?'} ｜ 接受 ${c.applied ?? '?'} ｜ 拒绝 ${c.rejected ?? '?'} ｜ 状态 ${r.applyStatus ?? '?'}`,
        `结构复检：${r.verdict?.structuralPassed ?? r.verdict?.passed ? '通过' : '未通过'}`,
        r.mandatoryCheck ? `AIGC 复检：${r.mandatoryCheck.acceptance?.accepted ? '通过' : '未通过'}` : '',
        r.mandatoryCheck ? `正文 AI 疑似：${pct(r.prob?.before)} → ${pct(r.prob?.after)}` : '',
        r.mandatoryCheck?.acceptance?.failed?.length
          ? `未通过项：${r.mandatoryCheck.acceptance.failed.join('、')}`
          : '',
        `改稿：${r.output}`,
        r.rolledBack ? '注意：篇级校验未通过，本版仍保留供下载/继续修改' : '',
      ].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'paper_dual_aigc',
    description: 'AIGC 考官：计算正文 AI 疑似占比、档位、三粒度稳定度与块级定位，并做 9 维 AI 痕迹诊断。'
      + '必须安装 transformers + torch；缺依赖时只返回安装步骤，不生成伪分数。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['original', 'rewritten'],
          description: 'original=原文，rewritten=当前改稿；也可用 versionId 指定 v1/v2/...',
        },
        versionId: { type: 'string', description: '版本 id，例如 original、v1、v2' },
        withDiag: { type: 'boolean', description: '是否附带 9 维痕迹诊断，默认 true' },
      },
    },
    async handler(args) {
      const target = args?.versionId || args?.target || 'original';
      const s = await core.aigcScore({ target });
      if (!s.ok) {
        return fail([
          `打分失败：${s.error}`,
          s.setup?.installScript ? 'PowerShell 安装步骤：' : '',
          s.setup?.installScript || '',
          s.setup?.manualSteps?.length ? s.setup.manualSteps.join('\n') : '',
          s.setup?.modelUrl ? `模型：${s.setup.modelUrl}` : '',
        ].filter(Boolean).join('\n'));
      }
      const r = s.result ?? {};
      const share = core.aigcShare(r);
      const legacy = core.aigcMeasurement(r) !== 'ai_share';
      const segsAll = (r.segments ?? []).filter((g) => !g.group || g.group === 'rewritable');
      const segs = segsAll.slice()
        .sort((a, b) => (
          Number(b.contribution ?? 0) - Number(a.contribution ?? 0)
          || Number(b.ai_prob ?? 0) - Number(a.ai_prob ?? 0)
        ))
        .slice(0, 8)
        .map((g) => `#${g.index} 块分 ${(100 * g.ai_prob).toFixed(0)}% / 贡献 ${(100 * Number(g.contribution ?? 0)).toFixed(1)}%`)
        .join(' · ');
      const lines = [
        `AIGC 考官（真机）｜ ${target}`,
        `正文 AI 疑似占比 ${pct(share)} ｜ ${r.body_chars ?? r.chars} 字 ｜ ${segsAll.length} 块`
          + ` ｜ ${r.calibrated ? '已校准' : '未校准'} ｜ ${core.AIGC_BAND_LABELS[r.band] || '未判档'}`
          + ` ｜ ${r.comparison_mode === 'frozen' ? '冻结块' : '重新切块'}`
          + `${legacy ? ' ｜ 旧口径（均值）' : ''}`,
        `全篇 ${pct(r.all_ai_share ?? r.ai_share)}`
          + ` ｜ 表格 ${r.table_ai_share == null ? '—' : pct(r.table_ai_share)}`
          + ` ｜ 参考文献 ${r.reference_ai_share == null ? '—' : pct(r.reference_ai_share)}`,
        r.stability != null ? `切分稳定度 ${Number(r.stability).toFixed(4)}${Number(r.stability) > 0.06 ? '（结论依赖切分，建议看块级）' : ''}` : '',
        segs ? `贡献最高块：${segs}${segsAll.length > 8 ? ` …共 ${segsAll.length} 块` : ''}` : '',
      ];
      if (r.top?.length) {
        lines.push(`正文块定位：${r.top.slice(0, 8).map((x) => `${x.pid}(${pct(x.ai_prob)})`).join(' · ')}`);
      }
      if (args?.withDiag !== false) {
        const dg = await core.aigcDiag({ target });
        if (dg.ok) {
          lines.push(
            `9 维诊断：风险 ${dg.result.risk_count} 项 ｜ 等级 ${dg.result.level}`
            + ` ｜ 语体门禁 ${dg.result.style_gate_passed ? '通过' : '未通过'}`
            + `${dg.gateRewritable !== dg.gateAll ? `（可改写段：${dg.gateRewritable ? '通过' : '未通过'}）` : ''}`,
            ...(dg.result.todo ?? []).map((t) => `  · ${t}`),
          );
        } else {
          lines.push(`9 维诊断失败：${dg.error}`);
        }
      }
      lines.push('边界：本口径是插件自有模型下的 AI 疑似占比，不等同知网/维普等平台判定。');
      return ok(lines.filter(Boolean).join('\n'));
    },
  },
  {
    name: 'paper_dual_recheck',
    description: '对当前改稿做手动复检：9 维痕迹、篇内重复率、正文 AI 疑似占比与冻结块比较；不通过默认自动整篇回退到基础稿。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        autoRollback: { type: 'boolean', description: '不通过时是否自动回退，默认 true' },
        requireModel: { type: 'boolean', description: '是否强制 AIGC 模型复检，默认 true' },
      },
    },
    async handler(args) {
      const r = await core.reduceCheck({
        autoRollback: args?.autoRollback !== false,
        requireModel: args?.requireModel !== false,
        trigger: 'manual',
      });
      if (!r.ok) return fail(`复检失败：${r.error}`);
      const a = r.acceptance ?? {};
      const lines = [
        `版本：${r.baseVersionLabel} → ${r.versionLabel}（第 ${r.round} 轮）`,
        `结论：${a.accepted ? '通过' : '不通过'}${a.failed?.length ? ` ｜ ${a.failed.join('、')}` : ''}`,
        `语体门禁：${a.gate ? '通过' : '未通过'} ｜ 9 维：${r.diag?.before?.riskCount} → ${r.diag?.after?.riskCount} 项`
          + `（风险分 ${r.diag?.before?.riskScore} → ${r.diag?.after?.riskScore}）`,
        r.dup ? `篇内重复率：${(100 * Number(r.dup.before ?? 0)).toFixed(1)}% → ${(100 * Number(r.dup.after ?? 0)).toFixed(1)}%` : `篇内重复率：未复检${r.dupError ? `（${r.dupError}）` : ''}`,
        r.prob ? `正文 AI 疑似：${pct(r.prob.before)} → ${pct(r.prob.after)}${r.prob.frozenBlocks ? '（冻结块）' : '（未冻结）'}` : '正文 AI 疑似：未复检',
        r.pacing?.deltaTotal != null ? `对称串：${r.pacing.origin} → ${r.pacing.after}（累计 ${r.pacing.deltaTotal > 0 ? '-' : '+'}${Math.abs(r.pacing.deltaTotal)}）` : '',
        r.acceptedSnapshot ? '已保存为验收稿（accepted.docx）' : '',
        r.rollback?.performed ? `已回退：${r.rollback.restoredFrom}` : '',
        r.nextRound?.canContinue
          ? `下一轮建议段落：${(r.nextRound.focusPids ?? []).join(', ')}（可继续第 ${r.nextRound.nextRound} 轮）`
          : '',
      ];
      return ok(lines.filter(Boolean).join('\n'));
    },
  },
  {
    name: 'paper_dual_rollback',
    description: '把当前改稿整篇回退到基础稿，保留被拒稿到 rejected-* 目录。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    async handler() {
      const run = core.currentRun();
      if (!run) return fail('还没有运行记录，先诊断一次');
      const version = core.activeVersion(run);
      if (!version || version.id === 'original') return fail('当前选中的是原文，没有可回退的改稿');
      const r = await core.rollbackSemantic(run, version);
      return ok([
        `已回退：${version.label}（${version.id}）`,
        `恢复自：${r.restoredFrom}`,
        `被拒稿：${r.rejectedDir}`,
      ].join('\n'));
    },
  },
  {
    name: 'paper_dual_report',
    description: '读取当前版本的诊断/复检报告或产物：report.md、profile.json、verdict、result；action=compare 时输出三栏对照。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['report', 'profile', 'verdict', 'result', 'compare'],
          description: '默认 report',
        },
        versionId: { type: 'string', description: '可选版本 id，默认当前版本' },
        limit: { type: 'integer', description: 'compare 最多返回多少段，默认 20' },
      },
    },
    async handler(args) {
      const run = core.currentRun();
      if (!run) return fail('还没有运行记录，先诊断一次');
      const version = args?.versionId ? core.versionById(run, args.versionId) : core.activeVersion(run);
      const dir = version?.workdir || run.outdir;
      const action = args?.action ?? 'report';
      if (action === 'compare') {
        const rows = core.buildCompare(version);
        if (!rows.length) return fail('当前版本没有可对照的回填记录');
        const limit = Math.max(1, Math.min(Number(args?.limit) || 20, 100));
        const out = [`三栏对照：${version?.label ?? '当前版本'}（显示 ${Math.min(rows.length, limit)}/${rows.length} 段）`];
        for (const row of rows.slice(0, limit)) {
          out.push(
            `\n[${row.pid}] ${row.op} ｜ 字数 ${row.chars[0]}→${row.chars[1]} ｜ 句数 ${row.sentences[0]}→${row.sentences[1]}`,
            `原文：${row.before}`,
            `改文：${row.after}`,
          );
        }
        return ok(out.join('\n'));
      }
      const files = {
        report: 'report.md',
        profile: 'profile.json',
        verdict: 'rewritten.verdict.json',
        result: 'rewritten.result.json',
      };
      const name = files[action] || 'report.md';
      const candidates = [join(dir, name), join(dir, `version.${name}`), join(run.outdir, name)];
      const hit = candidates.find((p) => existsSync(p));
      if (!hit) return fail(`没有找到 ${name}；先诊断或回填一次。查找位置：${candidates.join(' ｜ ')}`);
      return ok(`文件：${hit}\n\n${core.readText(hit) ?? ''}`);
    },
  },
  {
    name: 'paper_dual_setup',
    description: '环境与配置：action=status 查看引擎/Python/AIGC 状态；set_config 设置 pythonPath、engineDir、hfCacheDir、aiLabel；'
      + 'doctor 跑引擎自检；calibrate 做 AIGC 方向标定；selftest 跑考官离线自检。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'set_config', 'doctor', 'calibrate', 'selftest'],
          description: '默认 status',
        },
        pythonPath: { type: 'string', description: 'Python 解释器绝对路径（建议指向装有 torch/transformers 的 venv）' },
        engineDir: { type: 'string', description: '自定义引擎目录；默认使用插件内置 engine/' },
        hfCacheDir: { type: 'string', description: 'HuggingFace 模型缓存目录' },
        aiLabel: { type: 'integer', description: 'AIGC 标签方向：0 或 1（标定不可信时手动指定）' },
      },
    },
    async handler(args) {
      const action = args?.action ?? 'status';
      if (action === 'set_config') {
        const patch = {};
        if (typeof args?.pythonPath === 'string' && args.pythonPath.trim()) patch.pythonPath = args.pythonPath.trim();
        if (typeof args?.engineDir === 'string' && args.engineDir.trim()) patch.engineDir = args.engineDir.trim();
        if (typeof args?.hfCacheDir === 'string' && args.hfCacheDir.trim()) patch.hfCacheDir = args.hfCacheDir.trim();
        if (Number.isInteger(args?.aiLabel) && [0, 1].includes(args.aiLabel)) patch.aiLabel = args.aiLabel;
        if (!Object.keys(patch).length) return fail('没有可写入的配置项');
        core.saveState(patch);
        return ok(`已保存配置：${JSON.stringify(patch, null, 2)}`);
      }
      if (action === 'doctor') {
        const dir = core.engineDir();
        if (!existsSync(join(dir, 'run.py'))) return fail(`引擎目录里没有 run.py：${dir}`);
        const r = await core.runCmd(core.pythonBin(), ['run.py', 'doctor'], dir, 60000);
        return ok(`${r.code === 0 ? '自检通过' : '自检未通过'}\n\n${core.clip(`${r.out}${r.err}`, 4000)}`);
      }
      if (action === 'calibrate') {
        const r = await core.aigcCalibrate();
        if (!r.ok) return fail(`标定失败：${r.error}${r.hint ? `（${r.hint}）` : ''}`);
        return ok(`标定完成：aiLabel=${r.aiLabel}${r.trusted === false ? '（探针区分度不足，建议手动指定 aiLabel）' : ''}\n${JSON.stringify(r.info)}`);
      }
      if (action === 'selftest') {
        const r = await core.aigcSelftest();
        return r.ok
          ? ok(`考官自检通过：${r.passed ?? '?'}/${r.total ?? '?'}\n${r.log}`)
          : fail(`考官自检未通过：${r.passed ?? '?'}/${r.total ?? '?'}\n${r.log}`);
      }
      const [a, py] = await Promise.all([core.aigcStatus(), core.pythonExecutable()]);
      const dir = core.engineDir();
      return ok([
        `引擎：${dir}（${existsSync(join(dir, 'run.py')) ? '就绪' : '缺少 run.py'}）`,
        `Python：${py || core.pythonBin()}`,
        `状态目录：${core.stateDir()}`,
        `AIGC：${a.detectorReady ? '真机就绪' : '未安装 torch/transformers'} ｜ 模型 ${a.model}`,
        `标定：${a.calibration?.calibrated ? '已校准' : '未校准'}`,
        `依赖版本：${JSON.stringify(a.versions ?? {})}`,
        a.setup?.missing?.length ? `缺少：${a.setup.missing.join(', ')}` : '',
        a.setup?.installScript ? `\n安装步骤：\n${a.setup.installScript}` : '',
      ].filter(Boolean).join('\n'));
    },
  },
];

const toolMap = new Map(tools.map((t) => [t.name, t]));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') {
      if (!isNotification) send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const tool = toolMap.get(name);
      if (!tool) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${name}` } });
        return;
      }
      const result = await tool.handler(params?.arguments ?? {});
      send({ jsonrpc: '2.0', id, result });
      return;
    }
    if (method === 'resources/list') {
      send({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    }
    if (method === 'prompts/list') {
      send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    }
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
    }
  } catch (e) {
    if (!isNotification) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
    } else {
      process.stderr.write(`[trae-paper-dual] ${String(e?.message ?? e)}\n`);
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    process.stderr.write('[trae-paper-dual] 收到非 JSON 输入，已忽略\n');
    return;
  }
  void handle(msg);
});

process.stderr.write(`[trae-paper-dual] MCP server ready v${core.VERSION}\n`);
