#!/usr/bin/env node
/**
 * kpFlows 上云通道守护（P1 单向备份，2026-11-23）
 *
 * 决策：kpFlows 上云 = 工作台「只读零回写」架构的第二个例外（第一个是 orders）。
 * 与 orders 同款收窄纪律，静态断言（读源码不跑云，与 test-web-tutor-proxy 同风格）：
 *   A. 云端 webAdminWrite kpflows 通道：对象形态、白名单恰 save/list、
 *      整流快照字段白名单重建（身份键不落地）、LWW、通关只进不出、E2E 清理覆盖
 *   B. 工作台写函数收窄：单一调用方（kpFlowSync）、单键 payload、身份键禁传
 *   C. 备份纪律：本地第一读写源、失败留队列重推、只推不改（无读回写本地）
 *   D. 三个文件 node --check 语法必须过
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const wawPath = path.join(ROOT, 'cloudfunctions/webAdminWrite/index.js');
const WB_ROOT = path.join(os.homedir(), 'Desktop', '全科导学专家-小程序', '全学科导学工作台');
const ccPath = path.join(WB_ROOT, 'src/cloudClient.ts');
const syncPath = path.join(WB_ROOT, 'src/logic/kpFlowSync.ts');
const storePath = path.join(WB_ROOT, 'src/logic/kpFlowStore.ts');

let n = 0;
let bad = 0;
const ok = (cond, msg) => {
  n++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) bad++;
};

const waw = fs.readFileSync(wawPath, 'utf8');
const waq = fs.readFileSync(path.join(ROOT, 'cloudfunctions/webAdminQuery/index.js'), 'utf8');
const cc = fs.readFileSync(ccPath, 'utf8');
const sync = fs.readFileSync(syncPath, 'utf8');
const store = fs.readFileSync(storePath, 'utf8');

console.log('── A. 云端 webAdminWrite kpflows 通道 ──');
ok(/if \(event\.kpflows !== undefined\) \{/.test(waw), 'A1 存在 kpflows 专用通道');
ok(/kpflows 必须是对象 \{ action, flows\? \}；批量数组写入被拒绝/.test(waw), 'A2 对象形态校验 + 数组拒绝');
ok(/act === 'save'/m.test(waw) && /act === 'list'/m.test(waw), 'A3 白名单恰为 save / list');
ok(/未知 kpflows action/.test(waw), 'A4 未知 action 显式报错（不静默忽略）');
ok(/const KP_FLOW_FIELDS = \[/.test(waw), 'A5 整流快照按字段白名单重建 doc（端上多余键不落地）');
ok(/KP_FLOW_STATUSES\.indexOf\(doc\.status\) < 0/.test(waw), 'A6 status/step 非法整条拒绝（不静默修复）');
ok(/cloud\.status === 'cleared' && doc\.status !== 'cleared'/.test(waw), 'A7 通关只进不出（cleared 不可被降级覆盖）');
ok(/if \(cAt > mAt\) \{ skipped\+\+; continue; \}/.test(waw), 'A8 per-flow LWW（updatedAt 为准）');
ok(/doc\.reviewRound > \(Number\(cloud\.reviewRound\) \|\| 0\)/.test(waw), 'A9 tie 取 reviewRound 大者');
ok(/doc\(flowId\)\.set\(fresh\)/.test(waw), 'A10 _id = flowId 显式落库（天然幂等去重）');
ok(/createCollection\(COLLS\.kpflows\)/.test(waw), 'A11 ensureCollection 双保险');
ok(/modelVersion = KP_FLOW_MODEL_VERSION/.test(waw) && /echo-loop-v1/.test(waw), 'A12 记录模型版本（可并存升级）');
ok(/const fresh = Object\.assign\(\{ openid \}, doc\)/.test(waw), 'A13 openid 由服务端注入（端上不传）');
ok(/E2E_SCOPES = \['tutor_sessions', 'tutor_orders', 'kp_flows'\]/.test(waw), 'A14 E2E 清理白名单覆盖 kp_flows');
ok(!/tutor_evidence/.test(waw.match(/const KP_FLOW_FIELDS = \[[\s\S]*?\]/)[0]), 'A15 快照字段白名单不含证据字段');
ok(/'learnerNo', 'legacy'\]/.test(waw), 'A16 P2 白名单已补 learnerNo + legacy（白名单重建，不加即被丢弃）');

console.log('── A2. 云端 webAdminQuery sync 读回段（P2，2026-11-23）──');
ok(/kpflows: 'kp_flows'/.test(waq), 'A17 COLLS 注册 kp_flows');
ok(/KP_FLOWS_CLEARED_LIMIT = 100/.test(waq), 'A18 截断上限常量 = 100（仅截已通关）');
ok(/kpFlows: \(\(\) => \{/.test(waq), 'A19 sync 载荷含 kpFlows 段');
ok(/truncated: clearedAll\.length > KP_FLOWS_CLEARED_LIMIT/.test(waq), 'A20 truncated 标志（超限明示，不静默）');
ok(/total: rows\.length/.test(waq), 'A21 total = 账号全部条数（含被截掉的）');
ok(/status !== 'cleared'/.test(waq) && /status === 'cleared'/.test(waq), 'A22 截断口径：未通关全量 + 已通关倒序取最近');
ok(/learnerNo', 'legacy'/.test(waq), 'A23 读回字段与写白名单同源（含 learnerNo/legacy）');
ok(/sort\(\(a, b\) => String\(b\.updatedAt \|\| ''\)\.localeCompare/.test(waq), 'A24 已通关按 updatedAt 倒序');

console.log('── B. 工作台写函数收窄（cloudClient.ts）──');
ok(/callWebAdminWriteKpflows/.test(cc), 'B1 存在 kpflows 专用写函数');
ok(/仅 `src\/logic\/kpFlowSync\.ts`/.test(cc), 'B2 调用方限定 kpFlowSync（单一入口）');
ok(/action !== 'save' && action !== 'list'/.test(cc), 'B3 action 白名单 save/list');
ok(/\['openid', '_openid', 'adminKey', 'childId', 'baseUpdatedAt'\]/.test(cc), 'B4 身份/作用域键禁传');
ok(/kpflows: \{ action, \.\.\.\(action === 'save' \? \{ flows \} : \{\}\) \}/.test(cc), 'B5 payload 单键 kpflows（函数内组装）');
ok(/例外 2（2026-11-23 kpFlows 上云决策）/.test(cc), 'B6 架构例外已立决策记录');

console.log('── C. 备份纪律（kpFlowSync / kpFlowStore）──');
ok(/唯一调用方/.test(sync), 'C1 kpFlowSync 是写函数唯一调用方');
ok(/await import\('\.\.\/cloudClient'\)/.test(sync), 'C2 动态 import cloudClient（js-sdk 不进逻辑层）');
ok(/clearKpBackupQueue\(ids\.map\(\(id\) => \(\{ flowId: id, updatedAt: map\[id\]\.updatedAt \}\)\)\)/.test(sync), 'C3 清队按 updatedAt 匹配（推送期间更新不误删）');
ok(/_inFlight/.test(sync), 'C4 并发 flush 合并（门闩）');
ok(/enqueueKpFlowBackup\(flow\)/.test(store) && /enqueueKpFlowBackup\(next\)/.test(store), 'C5 三个变更点全部入队');
ok(/latest-wins/.test(store), 'C6 队列 latest-wins（不堆积并行版本）');
ok(/saveKpFlows\(merged\)/.test(sync) && !/enqueueKpFlowBackup|dispatchKpFlowEvent/.test(sync), 'C7 P2 合并直接落本地但不产生备份事件（拉取不回推）');
ok(/MERGE_CLOCK_WINDOW_MS = 5 \* 60 \* 1000/.test(sync), 'C8 时钟差窗口 5 分钟（reviewRound 大者→再取云端）');
ok(/localFlow\.status === 'cleared' && cloudFlow\.status !== 'cleared'/.test(sync) && /cloudFlow\.status === 'cleared' && localFlow\.status !== 'cleared'/.test(sync), 'C9 通关只进不出（双向生效）');
ok(/for \(const f of localById\.values\(\)\) merged\.push\(f\)/.test(sync), 'C10 本地独有流原样保留（永不删除）');
ok(/setCurrentLearnerNo\(mapped\.currentChildId\)/.test(fs.readFileSync(path.join(WB_ROOT, 'src/main.ts'), 'utf8')), 'C11 main.ts 拉取后登记当前孩子并触发合并');

console.log('── D. 语法 ──');
for (const p of [wawPath, ccPath, syncPath, storePath]) {
  const isJs = p.endsWith('.js');
  try {
    if (isJs) execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    ok(true, 'D ' + path.basename(path.dirname(p)) + '/' + path.basename(p) + (isJs ? ' node --check' : ' 可读'));
  } catch (e) { ok(false, 'D ' + p + ': ' + e.message); }
}

console.log(`\n通过 ${n - bad} 项，失败 ${bad} 项`);
if (bad) {
  console.log('❌ kpFlows 上云通道契约被破坏，提交/部署被阻断');
  process.exit(1);
}
console.log('✅ kpFlows 上云通道契约全通过（事实记录 / LWW / 通关只进不出 / 身份不入端）');
