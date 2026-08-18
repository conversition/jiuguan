/**
 * 验证脚本：沙箱隔离强化（0.5.0）——恶意插件静态拒载 + 死循环超时 + 权限声明
 * 运行：node --experimental-strip-types --experimental-transform-types tools/cli/verify-sandbox-isolation.ts
 */
import vm from 'node:vm';
import { scanServerSource, normalizePermissions } from '../../packages/plugin/src/scan.ts';
import type { PluginManifest } from '../../packages/plugin/src/manifest.ts';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

function main() {
  // ---- 场景1：逃逸特征拒载 ----
  const processExit = 'export function init(ctx){ process.exit(0); }';
  const r1 = scanServerSource(processExit);
  check('场景1 process.exit 拒载', !r1.ok && r1.deny.includes('process'), r1.deny);

  const childProc = 'const {exec}=require("child_process"); exec("rm -rf /");';
  const r2 = scanServerSource(childProc);
  check('场景2 child_process 拒载', !r2.ok && r2.deny.includes('child_process'), r2.deny);

  const fsWrite = 'require("fs").writeFileSync("/etc/passwd","x");';
  const r3 = scanServerSource(fsWrite);
  check('场景3 fs 写拒载', !r3.ok, r3.deny);

  const evalEsc = 'const g = eval("this"); g.constructor("return process")();';
  const r4 = scanServerSource(evalEsc);
  check('场景4 eval 逃逸拒载', !r4.ok, r4.deny);

  const network = 'fetch("http://evil.com");';
  const r5 = scanServerSource(network);
  check('场景5 网络访问拒载', !r5.ok, r5.deny);

  // ---- 场景2：正常插件通过 ----
  const benign = `export function init(ctx){ ctx.log('hi'); return { onMessageSend(){ return { promptInject:'x' }; } }; }`;
  const okR = scanServerSource(benign);
  check('场景2 正常插件通过', okR.ok, okR.deny);

  // ---- 场景3：权限声明归一化 ----
  const m1 = { permissions: { network: true } } as PluginManifest;
  const p1 = normalizePermissions(m1);
  check('场景3 归一化 permissions（network 开/其余关）', p1.network === true && p1.fs === false && p1.runtime === false, JSON.stringify(p1));
  const p2 = normalizePermissions({} as PluginManifest);
  check('场景3 未声明 = 最小权限', p2.network === false && p2.fs === false && p2.runtime === false, JSON.stringify(p2));

  // ---- 场景4：死循环在 vm 同步超时内被杀（不拖垮主进程） ----
  const sandbox = {};
  let killed = false;
  const t0 = Date.now();
  try {
    vm.runInContext('while(true){}', vm.createContext(sandbox), { timeout: 100 });
  } catch (e) {
    killed = (e as Error).name === 'Error' && String((e as Error).message).toLowerCase().includes('script execution timed out');
  }
  const elapsed = Date.now() - t0;
  check('场景4 死循环被 timeout 杀死', killed, '');
  check('场景4 超时 < 500ms（主进程未卡死）', elapsed < 500, `elapsed=${elapsed}ms`);

  console.log(failures === 0 ? '\n沙箱隔离验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
