/**
 * Shrink-only import boundary gate.
 *
 * Existing violations are recorded as exact rule/from/to/count edges. Normal
 * checks allow those edges only up to their recorded count. New/increased
 * edges fail; removals require committing a shrink-only baseline update so a
 * later change cannot silently reintroduce the retired dependency.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

interface GateConfig {
  version: number;
  roots: string[];
  sourceExtensions: string[];
  ignoredDirectories: string[];
  ignoredPaths: string[];
  baseline: string;
  rules: {
    crossWorkspacePackagePrivateSource: boolean;
    relativeNodeModulesTraversal: boolean;
    packageImportAlias: boolean;
    privateWorkspaceAlias: boolean;
    packageToOuterLayer: boolean;
    appToPluginOrTool: boolean;
    pluginToAppOrTool: boolean;
  };
}

interface BaselineFile {
  version: 1;
  generatedFrom: string;
  violations: Record<string, number>;
}

interface Violation {
  rule: string;
  from: string;
  to: string;
  specifier: string;
  line: number;
}

interface WorkspacePackage {
  name: string;
  root: string;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG_PATH = resolve(REPO_ROOT, 'tools/architecture/import-boundaries.json');
const normalize = (value: string): string => value.split(sep).join('/').replace(/^\.\//u, '');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function assertConfig(value: GateConfig): void {
  if (value.version !== 1 || !Array.isArray(value.roots) || !Array.isArray(value.sourceExtensions)
    || !Array.isArray(value.ignoredDirectories) || !Array.isArray(value.ignoredPaths)
    || typeof value.baseline !== 'string') {
    throw new Error('import-boundaries.json 格式无效');
  }
}

function walk(root: string, config: GateConfig, output: string[]): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()
      && config.ignoredDirectories.some((item) => item.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) continue;
    const absolute = resolve(root, entry.name);
    const repoRelative = normalize(relative(REPO_ROOT, absolute));
    if (entry.isDirectory()
      && config.ignoredPaths.some((item) => item.toLocaleLowerCase() === repoRelative.toLocaleLowerCase())) continue;
    if (entry.isDirectory()) walk(absolute, config, output);
    else if (entry.isFile()
      && config.sourceExtensions.some((item) => item.toLocaleLowerCase() === extname(entry.name).toLocaleLowerCase())) {
      output.push(absolute);
    }
  }
}

function moduleSpecifiers(source: ts.SourceFile): Array<{ value: string; line: number }> {
  const found: Array<{ value: string; line: number }> = [];
  const add = (node: ts.Node | undefined): void => {
    if (!node || !ts.isStringLiteralLike(node)) return;
    found.push({ value: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function workspaceOf(path: string): string | null {
  const parts = normalize(path).split('/');
  const layer = parts[0]?.toLocaleLowerCase() ?? '';
  return parts.length >= 2 && ['apps', 'packages', 'plugins', 'tools'].includes(layer)
    ? `${layer}/${parts[1].toLocaleLowerCase()}`
    : null;
}

function topLayer(path: string): string {
  return (normalize(path).split('/')[0] ?? '').toLocaleLowerCase();
}

function discoverWorkspacePackages(config: GateConfig): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const rootName of config.roots) {
    const root = resolve(REPO_ROOT, rootName);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = resolve(root, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson<{ name?: unknown }>(manifestPath);
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue;
      packages.push({ name: manifest.name, root: normalize(relative(REPO_ROOT, resolve(root, entry.name))) });
    }
  }
  return packages.sort((a, b) => b.name.length - a.name.length);
}

function resolveWorkspaceSpecifier(specifier: string, packages: WorkspacePackage[]): string | null {
  const comparable = specifier.toLocaleLowerCase();
  const target = packages.find((item) => (
    comparable === item.name.toLocaleLowerCase()
    || comparable.startsWith(`${item.name.toLocaleLowerCase()}/`)
  ));
  if (!target) return null;
  const suffix = specifier.slice(target.name.length).replace(/^\//u, '');
  return suffix ? `${target.root}/${suffix}` : target.root;
}

function resolveRelativeSpecifier(absolute: string, specifier: string): string {
  const lexicalTarget = resolve(dirname(absolute), specifier);
  // pnpm workspace dependencies are directory junctions on Windows. Classify
  // the physical target when it exists so `../node_modules/@scope/pkg/src/*`
  // cannot disguise a cross-workspace/private-source dependency.
  const physicalTarget = existsSync(lexicalTarget) ? realpathSync(lexicalTarget) : lexicalTarget;
  return normalize(relative(REPO_ROOT, physicalTarget));
}

function classifySpecifier(input: {
  absolute: string;
  from: string;
  fromWorkspace: string | null;
  line: number;
  rawSpecifier: string;
}, config: GateConfig, workspacePackages: WorkspacePackage[]): Violation[] {
  const { absolute, from, fromWorkspace, line, rawSpecifier } = input;
  const violations: Violation[] = [];
  // Node package "imports" aliases (#name) can redirect to another workspace
  // through package.json. Until mappings are parsed end-to-end, fail closed.
  if (rawSpecifier.startsWith('#') && config.rules.packageImportAlias) {
    violations.push({
      rule: 'package-import-alias', from, to: rawSpecifier, specifier: rawSpecifier, line,
    });
    return violations;
  }
  const specifier = rawSpecifier.replace(/[?#].*$/u, '');
  if (/^@jiuguan\/[^/]+\/src(?:\/|$)/iu.test(specifier) && config.rules.privateWorkspaceAlias) {
    violations.push({ rule: 'private-workspace-alias', from, to: specifier, specifier: rawSpecifier, line });
  }

  const relativeSpecifier = specifier.startsWith('.');
  if (relativeSpecifier && config.rules.relativeNodeModulesTraversal) {
    const lexicalTo = normalize(relative(REPO_ROOT, resolve(dirname(absolute), specifier)));
    if (/(?:^|\/)node_modules(?:\/|$)/iu.test(lexicalTo)) {
      violations.push({
        rule: 'relative-node-modules-traversal', from, to: lexicalTo, specifier: rawSpecifier, line,
      });
    }
  }
  const to = relativeSpecifier
    ? resolveRelativeSpecifier(absolute, specifier)
    : resolveWorkspaceSpecifier(specifier, workspacePackages);
  if (!to) return violations;

  const fromLayer = topLayer(from);
  const toLayer = topLayer(to);
  const privatePackage = relativeSpecifier
    ? to.match(/^packages\/([^/]+)\/src(?:\/|$)/iu)?.[1]?.toLocaleLowerCase()
    : undefined;
  if (privatePackage && config.rules.crossWorkspacePackagePrivateSource
    && fromWorkspace !== `packages/${privatePackage}`) {
    violations.push({
      rule: 'cross-workspace-package-private-source', from, to, specifier: rawSpecifier, line,
    });
  }
  if (fromLayer === 'packages' && ['apps', 'plugins', 'tools'].includes(toLayer)
    && config.rules.packageToOuterLayer) {
    violations.push({ rule: 'package-to-outer-layer', from, to, specifier: rawSpecifier, line });
  }
  if (fromLayer === 'apps' && ['plugins', 'tools'].includes(toLayer)
    && config.rules.appToPluginOrTool) {
    violations.push({ rule: 'app-to-plugin-or-tool', from, to, specifier: rawSpecifier, line });
  }
  if (fromLayer === 'plugins' && ['apps', 'tools'].includes(toLayer)
    && config.rules.pluginToAppOrTool) {
    violations.push({ rule: 'plugin-to-app-or-tool', from, to, specifier: rawSpecifier, line });
  }
  return violations;
}

function collectViolations(config: GateConfig): Violation[] {
  const files: string[] = [];
  for (const root of config.roots) walk(resolve(REPO_ROOT, root), config, files);
  const workspacePackages = discoverWorkspacePackages(config);
  const violations: Violation[] = [];
  for (const absolute of files.sort()) {
    const from = normalize(relative(REPO_ROOT, absolute));
    const fromWorkspace = workspaceOf(from);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const item of moduleSpecifiers(source)) {
      violations.push(...classifySpecifier({
        absolute,
        from,
        fromWorkspace,
        line: item.line,
        rawSpecifier: item.value,
      }, config, workspacePackages));
    }
  }
  return violations;
}

const violationKey = (item: Pick<Violation, 'rule' | 'from' | 'to'>): string => (
  `${item.rule}\u0000${item.from}\u0000${item.to}`
);

function countsOf(items: Violation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[violationKey(item)] = (counts[violationKey(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function writeBaseline(path: string, counts: Record<string, number>): void {
  const body: BaselineFile = {
    version: 1,
    generatedFrom: 'authorized-session-package-migration-2026-10-07',
    violations: counts,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function runSelfTest(config: GateConfig, verbose: boolean): void {
  const workspacePackages: WorkspacePackage[] = [
    { name: '@fixture/app', root: 'apps/fixture' },
    { name: '@fixture/package', root: 'packages/fixture' },
    { name: '@fixture/other-package', root: 'packages/other' },
    { name: '@fixture/plugin', root: 'plugins/fixture' },
    { name: '@fixture/tool', root: 'tools/fixture' },
  ];
  const classify = (from: string, rawSpecifier: string): string[] => classifySpecifier({
    absolute: resolve(REPO_ROOT, from),
    from,
    fromWorkspace: workspaceOf(from),
    line: 1,
    rawSpecifier,
  }, config, workspacePackages).map((item) => item.rule);
  const expectRule = (label: string, actual: string[], expected: string): void => {
    if (!actual.includes(expected)) throw new Error(`self-test ${label} 未触发 ${expected}: ${actual.join(', ')}`);
  };

  const parsed = ts.createSourceFile(
    'self-test.ts',
    "import '@fixture/app'; export * from '../../packages/core/src/private.ts'; void import('@fixture/tool');",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (moduleSpecifiers(parsed).length !== 3) throw new Error('self-test AST 未覆盖 import/export/dynamic import');

  expectRule(
    'cross-workspace-relative',
    classify('apps/fixture/src/file.ts', '../../../packages/core/src/private.ts'),
    'cross-workspace-package-private-source',
  );
  expectRule(
    'private-alias',
    classify('apps/fixture/src/file.ts', '@jiuguan/core/src/private.ts'),
    'private-workspace-alias',
  );
  expectRule(
    'package-bare-alias',
    classify('packages/fixture/src/file.ts', '@fixture/app'),
    'package-to-outer-layer',
  );
  expectRule(
    'app-bare-alias',
    classify('apps/fixture/src/file.ts', '@fixture/tool/subpath'),
    'app-to-plugin-or-tool',
  );
  expectRule(
    'plugin-bare-alias',
    classify('plugins/fixture/src/file.ts', '@fixture/app'),
    'plugin-to-app-or-tool',
  );
  expectRule(
    'windows-case-variant-relative',
    classify('APPS/fixture/src/file.ts', '../../../PACKAGES/core/SRC/private.ts'),
    'cross-workspace-package-private-source',
  );
  expectRule(
    'windows-case-variant-alias',
    classify('PACKAGES/fixture/src/file.ts', '@FIXTURE/APP'),
    'package-to-outer-layer',
  );
  expectRule(
    'relative-node-modules-js-alias',
    classify(
      'packages/fixture/src/file.ts',
      '../NODE_MODULES/@jiuguan/mobile-contracts/src/index.js',
    ),
    'relative-node-modules-traversal',
  );
  expectRule(
    'package-import-alias',
    classify('packages/fixture/src/file.ts', '#provider'),
    'package-import-alias',
  );
  if (classify('packages/fixture/src/file.ts', '@fixture/other-package').length !== 0) {
    throw new Error('self-test 将允许的 package → package 公共依赖误判为违规');
  }
  if (classify('packages/fixture/src/file.ts', './local.ts').length !== 0) {
    throw new Error('self-test 将包内相对依赖误判为违规');
  }
  if (verbose) {
    console.log('import 门禁 self-test：AST、相对/bare/#alias、junction、大小写与负例均通过');
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const config = readJson<GateConfig>(CONFIG_PATH);
  assertConfig(config);
  // Always exercise the classifier so weakening a rule cannot masquerade as
  // a harmless baseline improvement. --self-test merely makes it visible.
  runSelfTest(config, args.has('--self-test'));
  const baselinePath = resolve(REPO_ROOT, config.baseline);
  const violations = collectViolations(config);
  const counts = countsOf(violations);

  if (args.has('--write-initial-baseline')) {
    if (existsSync(baselinePath) && statSync(baselinePath).size > 0) {
      throw new Error('baseline 已存在；禁止 full 覆盖。请修复新增违规或使用 --shrink-baseline');
    }
    writeBaseline(baselinePath, counts);
    console.log(`已建立初始 import baseline：${Object.keys(counts).length} 条边 / ${violations.length} 次引用`);
    return;
  }
  if (!existsSync(baselinePath)) throw new Error('缺少 import baseline；仅首次落地可使用 --write-initial-baseline');
  const baseline = readJson<BaselineFile>(baselinePath);
  if (baseline.version !== 1 || !baseline.violations) throw new Error('import baseline 格式无效');

  const newEdges = Object.entries(counts).filter(([key, count]) => count > (baseline.violations[key] ?? 0));
  const retired = Object.entries(baseline.violations).filter(([key, count]) => (counts[key] ?? 0) < count);
  if (newEdges.length > 0) {
    console.error(`import 门禁失败：发现 ${newEdges.length} 条新增/增量违规边`);
    const byKey = new Map(violations.map((item) => [violationKey(item), item]));
    for (const [key, count] of newEdges.slice(0, 30)) {
      const item = byKey.get(key)!;
      console.error(`  - ${item.rule}: ${item.from}:${item.line} -> ${item.to} (${item.specifier}) count=${count}, allowed=${baseline.violations[key] ?? 0}`);
    }
    process.exitCode = 1;
    return;
  }
  if (args.has('--shrink-baseline')) {
    writeBaseline(baselinePath, counts);
    console.log(`baseline 已 shrink-only 更新：移除/缩减 ${retired.length} 条，未加入任何新违规`);
  } else if (retired.length > 0) {
    console.error(`import baseline 已过期：发现 ${retired.length} 条依赖改善，必须提交 shrink 结果以防日后回归`);
    console.error('请运行：pnpm check:imports -- --shrink-baseline');
    process.exitCode = 1;
    return;
  }
  console.log(`import 门禁通过：${Object.keys(counts).length} 条存量边 / ${violations.length} 次引用；新增 0`);
}

try {
  main();
} catch (error) {
  console.error(`import 门禁错误：${(error as Error).message}`);
  process.exitCode = 2;
}
