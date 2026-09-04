# jiuguan 初始化修复包（fix-pack-init）

> 版本：2026-09-04 ｜ 适用项目：酒馆提示词Agent/jiuguan（v0.6.1）
> 生成来源：初始化问题全链路审查（报告见项目根目录 `初始化问题审查报告.md`）

---

## 1. 这个包是什么

针对「项目无法正常初始化」的 **4 项修复 + 1 套自动化测试** 的自包含修复包。
把整个 `fix-pack-init` 文件夹拷进目标 jiuguan 项目根目录，一条命令应用，一条命令验证。

```
fix-pack-init/
├── README.md                      ← 本文件（修正方案说明）
├── apply-fixes.mjs                ← 一键应用脚本（把修复覆盖到目标项目）
├── fixed-files/                   ← 修复后的完整文件（按项目原始相对路径存放）
│   ├── 一键启动.bat
│   ├── pnpm-workspace.yaml
│   ├── apps/server/server.ts
│   └── apps/web/vite.config.ts
└── tests/
    ├── verify-init-fixes.ts       ← 自动化验证（6 项测试）
    └── run-tests.bat              ← 测试入口（双击即可）
```

---

## 2. 修了什么（问题 → 修复对照）

### 修复 #1（主因）：一键启动.bat 端口检测误判 →「跳过启动」导致后端实际没起

- **现象**：页面能打开，但卡片列表为空、建会话全失败（无法初始化）。
- **根因**：`netstat -ano | findstr ":17800 "` 会命中浏览器残留的 **TIME_WAIT** 连接（2~4 分钟内不消失），bat 误判「端口已在运行」而跳过后端启动；前端正常所以页面打开，但 `/api/*` 全部失败。
- **修复**：改为 `netstat -ano | findstr "LISTENING" | findstr ":17800 "`（5173 同理），只认监听状态。

### 修复 #2：后端端口被占时裸抛堆栈、「黑窗口一闪就退」

- **现象**：`pnpm web:server` 遇到端口占用直接崩溃（实测 exit=1，EADDRINUSE 堆栈），用户无从排查。
- **根因**：`apps/server/server.ts` 的 `server.listen()` 未挂 `error` 处理。
- **修复**：新增 `server.on('error')`，EADDRINUSE 时输出中文指引（运行 停止.bat / 换端口 `JG_WEB_PORT`）后干净退出。

### 修复 #3：Vite 端口被占时静默换端口

- **现象**：5173 被残留进程占用时 Vite 静默改用 5174，而一键启动仍打开 5173 → 页面打不开或加载旧进程。
- **根因**：`apps/web/vite.config.ts` 未设置 `strictPort`。
- **修复**：`server` 配置增加 `strictPort: true`，端口被占时明确报错 `Port xxx is already in use` 并退出（已实测）。
- **注**：Windows 下「通配符占位（绑 `::`）不拦截具体地址（`::1`）」是套接字语义特性，本修复保证 vite 至少不静默降级；残余场景由修复 #1/#2 兜底。

### 修复 #4：pnpm-workspace.yaml 残留旧盘符 storeDir（可移植性）

- **现象/风险**：`storeDir: e:/claude cade test/project/jiuguanlike/.pnpm-store` 指向旧项目位置；换环境 / E 盘路径变动后 `pnpm install` 直接失败（一键启动报「依赖安装失败」）。
- **修复**：移除该行，回落 pnpm 默认全局 store。**应用后建议跑一次 `pnpm install`**。

### 附带：启动指南.md 旧路径已同步更新（不在包内，属文档改动）

---

## 3. 如何在新环境使用

**前提**：目标机器已装 Node ≥ 22.5、pnpm 10+；`fix-pack-init` 整个文件夹位于 jiuguan 项目根目录下。

```bash
# 第 1 步（可选预览）
node fix-pack-init/apply-fixes.mjs --dry-run

# 第 2 步：应用修复（覆盖 4 个文件）
node fix-pack-init/apply-fixes.mjs

# 第 3 步：storeDir 改动后重装依赖
pnpm install

# 第 4 步：运行自动化验证（或双击 fix-pack-init\tests\run-tests.bat）
node --experimental-strip-types --experimental-transform-types fix-pack-init/tests/verify-init-fixes.ts

# 第 5 步：正常启动
一键启动.bat   （或分别 pnpm web:server / pnpm web:dev）
```

> ⚠️ 应用前请先关闭所有旧的 jiuguan 终端窗口；`apply-fixes.mjs` 会直接覆盖目标项目中的同名文件（覆盖前建议自行 git 提交或备份）。

---

## 4. 自动化测试覆盖项（tests/verify-init-fixes.ts）

| # | 测试 | 类型 | 通过标准 |
|---|---|---|---|
| T1 | 后端在空闲端口正常启动 | 动态 | stdout 出现 `http://127.0.0.1:<port>` |
| T2 | 端口被占 → 友好指引退出 | 动态 | exit=1 且输出含「已被占用 / 停止.bat」，无裸堆栈 |
| T3 | bat 端口检测改为 LISTENING 过滤 | 静态 | 17800 / 5173 两处均为 `findstr "LISTENING" \| findstr "..."` |
| T4 | vite strictPort 已启用 | 静态 | 配置含 `strictPort: true` |
| T5 | 旧盘符 storeDir 已移除 | 静态 | pnpm-workspace.yaml 无 `storeDir: e:` / 旧路径 |
| T6 | TIME_WAIT 残留不再触发误判 | 动态演示 | 构造 TIME_WAIT 连接后，新检测逻辑不报「运行中」 |

预期输出：`结果: 6 通过 / 0 失败`，退出码 0。任一失败退出码 1。

---

## 5. 修复文件改动明细（审查对照用）

| 文件 | 改动位置 |
|---|---|
| `一键启动.bat` | 第 30~36 行（API 检测）、第 39~45 行（Web 检测）：各加 LISTENING 过滤与注释 |
| `apps/server/server.ts` | `server.listen(PORT, HOST, ...)` 之前新增 `server.on('error', ...)` 8 行 |
| `apps/web/vite.config.ts` | `server` 配置内新增 `strictPort: true` 及注释 |
| `pnpm-workspace.yaml` | 删除 `storeDir: e:/...` 行，加注释说明 |
