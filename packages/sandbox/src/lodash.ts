/**
 * sandbox 包 - lodash 白名单子集（引擎硬依赖：cloneDeep/get/set/isEqual/random/sample/uniq）
 * 仅实现引擎实际调用的方法（tmp_scan 枚举：_.cloneDeep, _.get, _.isEqual, _.random, _.sample, _.set, _.uniq），
 * 不引入完整 lodash（无网络依赖、可控、沙箱友好）。
 */

type Obj = Record<string, unknown>;

function getPathSegs(path: string | string[]): string[] {
  if (Array.isArray(path)) return path.map(String);
  return String(path).split('.').filter((s) => s.length > 0);
}

/** _.get(obj, 'a.b.c' | ['a','b','c'], def?) */
export function lodashGet(obj: unknown, path: string | string[], def?: unknown): unknown {
  let cur: unknown = obj;
  for (const seg of getPathSegs(path)) {
    if (cur === null || cur === undefined) return def;
    if (typeof cur !== 'object') return def;
    cur = (cur as Obj)[seg];
  }
  return cur === undefined ? def : cur;
}

/** _.set(obj, 'a.b.c' | ['a','b','c'], value)：原地创建中间对象 */
export function lodashSet(obj: Obj, path: string | string[], value: unknown): Obj {
  const segs = getPathSegs(path);
  if (segs.length === 0) return obj;
  let cur: Obj = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const next = cur[seg];
    if (next === null || typeof next !== 'object') {
      const isArr = /^\d+$/.test(segs[i + 1]);
      cur[seg] = isArr ? [] : {};
    }
    cur = cur[seg] as Obj;
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

/** _.cloneDeep：结构化深拷贝（state 为纯 JSON 数据） */
export function lodashCloneDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => lodashCloneDeep(v)) as unknown as T;
  const out: Obj = {};
  for (const k of Object.keys(value as Obj)) {
    out[k] = lodashCloneDeep((value as Obj)[k]);
  }
  return out as T;
}

/** _.isEqual：深度比较（避免 JSON 键序问题，逐字段递归） */
export function lodashIsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Obj);
  const kb = Object.keys(b as Obj);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b as Obj, k)) return false;
    if (!lodashIsEqual((a as Obj)[k], (b as Obj)[k])) return false;
  }
  return true;
}

/** _.uniq：数组去重（保持顺序） */
export function lodashUniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** _.sample：随机取一个 */
export function lodashSample<T>(arr: T[]): T | undefined {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** _.random(min, max)：闭区间整数随机 */
export function lodashRandom(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 完整 mock 对象（注入沙箱 global 名 `_`） */
export function makeLodashMock(): Record<string, unknown> {
  return {
    get: lodashGet,
    set: lodashSet,
    cloneDeep: lodashCloneDeep,
    isEqual: lodashIsEqual,
    uniq: lodashUniq,
    sample: lodashSample,
    random: lodashRandom,
  };
}
