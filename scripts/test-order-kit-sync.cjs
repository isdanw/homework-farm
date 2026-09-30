/**
 * test-order-kit-sync.cjs —— orderKit 三端副本哈希锁（T06）
 * ---------------------------------------------------------------------------
 * 断言小程序 / 云函数 / 工作台三处副本与 order-kit/orderKit.js（canonical）
 * 的**逻辑体区段** sha256 完全一致 —— 逻辑可以外包壳，不能分叉。
 *
 *     node scripts/test-order-kit-sync.cjs
 *
 * 反证：手动往任一副本的逻辑体里改一个字符，本测试必须变红。
 */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '   → ' + extra : '')); }
}

console.log('orderKit 三端副本一致性（sha256 区段锁）\n');

const r = spawnSync(NODE, [path.join(ROOT, 'scripts/sync-order-kit.mjs'), '--check'], {
  cwd: ROOT, encoding: 'utf8'
});

const out = (r.stdout || '') + (r.stderr || '');
process.stdout.write(out.split('\n').map(l => l ? '  ' + l : l).join('\n'));

ok(r.status === 0, '--check 退出码为 0（全部副本与 canonical 一致）', 'status=' + r.status);
ok(/✓ 小程序/.test(out), '小程序副本一致');
ok(/✓ 云函数/.test(out), '云函数副本一致');
ok(/✓ 工作台/.test(out) || /跳过 工作台/.test(out),
  '工作台副本一致（目标工程不存在时合理跳过）');
ok(/sha256\(body\) = [0-9a-f]{64}/.test(out), '输出了 canonical 逻辑体 sha256');
ok(/导出名 \d+ 个/.test(out), '导出名清单解析成功');

/* 反证：把 canonical 复制成临时文件，篡改一个字符，确认 --check 能抓到 */
{
  const fs = require('fs');
  const canonical = path.join(ROOT, 'order-kit', 'orderKit.js');
  const victim = path.join(ROOT, 'cloudfunctions', 'tutorOrder', 'orderKit.js');
  if (fs.existsSync(victim)) {
    const backup = fs.readFileSync(victim, 'utf8');
    try {
      // 只改逻辑体里的一个字符（把 8 改成 9 之类的无害改动也要被抓到）
      const tampered = backup.replace("var PROTOCOL_VERSION = 'task-protocol-v1';",
        "var PROTOCOL_VERSION = 'task-protocol-v2';");
      ok(tampered !== backup, '反证：成功构造出被篡改的副本');
      fs.writeFileSync(victim, tampered, 'utf8');
      const r2 = spawnSync(NODE, [path.join(ROOT, 'scripts/sync-order-kit.mjs'), '--check'], {
        cwd: ROOT, encoding: 'utf8'
      });
      const out2 = (r2.stdout || '') + (r2.stderr || '');
      ok(r2.status !== 0, '反证：篡改后 --check 退出码非 0（测试真的能抓到分叉）', 'status=' + r2.status);
      ok(/✗/.test(out2) && /逻辑体与 canonical 不一致/.test(out2),
        '反证：输出明确指出逻辑体不一致');
    } finally {
      fs.writeFileSync(victim, backup, 'utf8');
      const r3 = spawnSync(NODE, [path.join(ROOT, 'scripts/sync-order-kit.mjs'), '--check'], {
        cwd: ROOT, encoding: 'utf8'
      });
      ok(r3.status === 0, '反证：恢复后 --check 重新通过（现场已还原）');
    }
  }
  ok(fs.existsSync(canonical), 'canonical 文件存在');
}

console.log('\n' + '─'.repeat(52));
console.log('通过 ' + pass + ' / 共 ' + (pass + fail) + (fail ? '   ✗ 失败 ' + fail : '   ✓ 全部通过'));
process.exit(fail ? 1 : 0);
