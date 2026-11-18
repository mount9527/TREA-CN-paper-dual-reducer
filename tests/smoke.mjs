// MCP 冒烟测试：不依赖 TRAE 宿主，直接通过 stdio 驱动 mcp/server.mjs。
// 覆盖：握手 → 工具列表 → 状态 → 诊断 → 生成任务 → 预检回填（纯降重）→ AIGC 缺依赖分支 → 报告。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIXTURE = join(ROOT, 'engine', 'tests', 'fixtures', 'sample.docx');
const EDITS = join(ROOT, 'engine', 'tests', 'fixtures', 'edits.jsonl');
const STATE = mkdtempSync(join(tmpdir(), 'paper-dual-smoke-'));

let nextId = 1;
const pending = new Map();

const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PAPER_DUAL_STATE_DIR: STATE,
    PAPER_DUAL_PYTHON: process.env.PAPER_DUAL_PYTHON || 'python',
    PYTHONUTF8: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));

function rpc(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolvePromise(msg.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function call(name, args) {
  return rpc('tools/call', { name, arguments: args ?? {} });
}

function body(result) {
  return (result?.content ?? []).map((c) => c.text ?? '').join('\n');
}

let failed = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed += 1;
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });
  check(init?.serverInfo?.name === 'trae-paper-dual', 'MCP 握手');

  const list = await rpc('tools/list', {});
  const names = (list?.tools ?? []).map((t) => t.name);
  check(names.length === 9, '工具数量 = 9', names.join(', '));

  const st = await call('paper_dual_status');
  check(body(st).includes('引擎：'), '状态可读', body(st).split('\n')[0]);

  const diag = await call('paper_dual_diagnose', { path: FIXTURE });
  const diagText = body(diag);
  check(!diag.isError && diagText.includes('诊断完成'), '诊断样本论文');
  console.log(diagText.split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n'));

  const rewrite = await call('paper_dual_rewrite', { path: FIXTURE, mode: 'dedupe' });
  const rewriteText = body(rewrite);
  check(!rewrite.isError && rewriteText.includes('提示词：'), '生成降重任务');
  const promptsPath = /提示词：(.+)/.exec(rewriteText)?.[1]?.trim();
  check(Boolean(promptsPath && existsSync(promptsPath)), 'prompts.jsonl 已生成', promptsPath || '');

  const apply = await call('paper_dual_apply_edits', {
    edits: readFileSync(EDITS, 'utf8'),
    scope: 'dedupe',
  });
  const applyText = body(apply);
  check(!apply.isError && applyText.includes('回填：'), '预检 + 回填');
  console.log(applyText.split('\n').map((l) => `      ${l}`).join('\n'));

  const aigc = await call('paper_dual_aigc', { target: 'original' }, 600000);
  const aigcText = body(aigc);
  check(
    aigcText.includes('AIGC 考官') || aigcText.includes('torch') || aigcText.includes('transformers'),
    'AIGC 考官分支',
    aigcText.split('\n')[0],
  );

  const report = await call('paper_dual_report', { action: 'report' });
  const reportText = body(report);
  check(!report.isError && reportText.includes('文件：'), '读取 report.md');

  const compare = await call('paper_dual_report', { action: 'compare' });
  const compareText = body(compare);
  check(compareText.includes('三栏对照') || compare.isError, '三栏对照');
} catch (e) {
  failed += 1;
  console.error(`FAIL  测试异常：${String(e?.message ?? e)}`);
} finally {
  child.kill();
  rmSync(STATE, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}
