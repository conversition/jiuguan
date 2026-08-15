/**
 * variable 包 - DSL 求值器（06 变量管理服务 §4.4 设计）
 * 白名单表达式语言：字面量 / 变量引用({key}) / 算术比较逻辑 / 白名单函数。
 * 特性：AST 递归下降求值 + 静态依赖提取（并行调度基础）+ 循环安全。
 *
 * 语法：
 *   expr    := orExpr
 *   orExpr  := andExpr (('||') andExpr)*
 *   andExpr := cmpExpr (('&&') cmpExpr)*
 *   cmpExpr := arithExpr (('=='|'!='|'<'|'>'|'<='|'>=') arithExpr)?
 *   arith   := term (('+'|'-') term)*
 *   term    := unary (('*'|'/'|'%') unary)*
 *   unary   := ('!'|'-') unary | primary
 *   primary := NUMBER | STRING | 'true'|'false' | '{' ident '}' | IDENT '(' args ')' | '(' expr ')'
 */

export type VarValue = number | string | boolean;

export type AstNode =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'ref'; name: string }
  | { type: 'bin'; op: string; left: AstNode; right: AstNode }
  | { type: 'unary'; op: string; node: AstNode }
  | { type: 'call'; name: string; args: AstNode[] };

// ── 白名单函数 ──
export const WHITELIST_FUNCS: Record<string, (args: VarValue[]) => VarValue> = {
  min: (a) => Math.min(...(a as number[])),
  max: (a) => Math.max(...(a as number[])),
  clamp: ([v, lo, hi]) => Math.max(Number(lo), Math.min(Number(hi), Number(v))),
  abs: ([v]) => Math.abs(Number(v)),
  round: ([v]) => Math.round(Number(v)),
  floor: ([v]) => Math.floor(Number(v)),
  ceil: ([v]) => Math.ceil(Number(v)),
  len: ([s]) => String(s).length,
  concat: (a) => a.map((x) => String(x)).join(''),
  // roll("d20") | roll("2d6+3") | roll(1,6)
  roll: (a) => {
    if (a.length === 1 && typeof a[0] === 'string') {
      const s = a[0] as string;
      const m = s.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
      if (m) {
        const count = m[1] ? parseInt(m[1], 10) : 1;
        const sides = parseInt(m[2], 10);
        const mod = m[3] ? parseInt(m[3], 10) : 0;
        let sum = mod;
        for (let i = 0; i < count; i++) sum += 1 + Math.floor(Math.random() * sides);
        return sum;
      }
      return 0;
    }
    const lo = Number(a[0] ?? 1);
    const hi = Number(a[1] ?? 6);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  },
};

// ── 词法 ──
interface Token { kind: 'num' | 'str' | 'ident' | 'op' | 'lp' | 'rp' | 'lb' | 'rb' | 'comma'; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '{') { tokens.push({ kind: 'lb', value: c }); i++; continue; }
    if (c === '}') { tokens.push({ kind: 'rb', value: c }); i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lp', value: c }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rp', value: c }); i++; continue; }
    if (c === ',') { tokens.push({ kind: 'comma', value: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j]; j++;
      }
      if (j >= src.length) throw new Error(`DSL 字符串未闭合: ${src.slice(i, i + 20)}`);
      tokens.push({ kind: 'str', value: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ kind: 'num', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_\u4e00-\u9fff]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_\u4e00-\u9fff]/.test(src[j])) j++;
      tokens.push({ kind: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // 运算符（最长匹配；命中后必须跳出 for 并继续外层 while）
    let opMatched = false;
    for (const op of ['<=', '>=', '==', '!=', '&&', '||']) {
      if (src.startsWith(op, i)) { tokens.push({ kind: 'op', value: op }); i += op.length; opMatched = true; break; }
    }
    if (opMatched) continue;
    if ('+-*/%<>!'.includes(c)) { tokens.push({ kind: 'op', value: c }); i++; continue; }
    throw new Error(`DSL 非法字符: "${c}"`);
  }
  return tokens;
}

// ── 解析（递归下降）──
class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private expect(kind: Token['kind'], what: string): Token {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`DSL 期望 ${what}，实际 ${t.kind}(${t.value})`);
    return t;
  }

  parse(): AstNode {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) throw new Error(`DSL 尾随 token: ${this.peek()?.value}`);
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.peek()?.value === '||') { this.next(); left = { type: 'bin', op: '||', left, right: this.parseAnd() }; }
    return left;
  }
  private parseAnd(): AstNode {
    let left = this.parseCmp();
    while (this.peek()?.value === '&&') { this.next(); left = { type: 'bin', op: '&&', left, right: this.parseCmp() }; }
    return left;
  }
  private parseCmp(): AstNode {
    let left = this.parseArith();
    const t = this.peek();
    if (t && t.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.value)) {
      this.next();
      left = { type: 'bin', op: t.value, left, right: this.parseArith() };
    }
    return left;
  }
  private parseArith(): AstNode {
    let left = this.parseTerm();
    while (this.peek()?.kind === 'op' && ['+', '-'].includes(this.peek()!.value)) {
      const op = this.next().value;
      left = { type: 'bin', op, left, right: this.parseTerm() };
    }
    return left;
  }
  private parseTerm(): AstNode {
    let left = this.parseUnary();
    while (this.peek()?.kind === 'op' && ['*', '/', '%'].includes(this.peek()!.value)) {
      const op = this.next().value;
      left = { type: 'bin', op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): AstNode {
    const t = this.peek();
    if (t?.kind === 'op' && (t.value === '!' || t.value === '-')) {
      this.next();
      return { type: 'unary', op: t.value, node: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  private parsePrimary(): AstNode {
    const t = this.next();
    switch (t.kind) {
      case 'num': return { type: 'num', value: Number(t.value) };
      case 'str': return { type: 'str', value: t.value };
      case 'ident':
        if (t.value === 'true') return { type: 'bool', value: true };
        if (t.value === 'false') return { type: 'bool', value: false };
        // 函数调用
        if (this.peek()?.kind === 'lp') {
          this.next();
          const args: AstNode[] = [];
          if (this.peek()?.kind !== 'rp') {
            args.push(this.parseOr());
            while (this.peek()?.kind === 'comma') { this.next(); args.push(this.parseOr()); }
          }
          this.expect('rp', ')');
          return { type: 'call', name: t.value, args };
        }
        // 裸标识符 → 视为变量引用（兼容 var:key 简写）
        return { type: 'ref', name: t.value };
      case 'lb': {
        // { 变量引用 }
        const name = this.next();
        if (name.kind !== 'ident') throw new Error('DSL 变量引用需标识符');
        this.expect('rb', '}');
        return { type: 'ref', name: name.value };
      }
      case 'lp': {
        const node = this.parseOr();
        this.expect('rp', ')');
        return node;
      }
      default: throw new Error(`DSL 意外 token: ${t.kind}`);
    }
  }
}

// ── 求值 ──
export type RefResolver = (name: string) => VarValue | undefined;

export function evaluate(node: AstNode, resolve: RefResolver): VarValue {
  switch (node.type) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'bool': return node.value;
    case 'ref': {
      const v = resolve(node.name);
      if (v === undefined) throw new Error(`变量未定义: ${node.name}`);
      return v;
    }
    case 'unary': {
      const v = evaluate(node.node, resolve);
      if (node.op === '!') return !v;
      if (node.op === '-') return -Number(v);
      throw new Error(`未知一元运算: ${node.op}`);
    }
    case 'bin': {
      const l = evaluate(node.left, resolve);
      const r = evaluate(node.right, resolve);
      switch (node.op) {
        case '+': return typeof l === 'number' && typeof r === 'number' ? l + r : String(l) + String(r);
        case '-': return Number(l) - Number(r);
        case '*': return Number(l) * Number(r);
        case '/': return Number(l) / Number(r);
        case '%': return Number(l) % Number(r);
        case '==': return l === r;
        case '!=': return l !== r;
        case '<': return Number(l) < Number(r);
        case '>': return Number(l) > Number(r);
        case '<=': return Number(l) <= Number(r);
        case '>=': return Number(l) >= Number(r);
        case '&&': return Boolean(l) && Boolean(r);
        case '||': return Boolean(l) || Boolean(r);
        default: throw new Error(`未知二元运算: ${node.op}`);
      }
    }
    case 'call': {
      const fn = WHITELIST_FUNCS[node.name];
      if (!fn) throw new Error(`函数不在白名单: ${node.name}`);
      const args = node.args.map((a) => evaluate(a, resolve));
      return fn(args);
    }
  }
}

/** 静态依赖提取：表达式引用的变量名集合（并行调度基础） */
export function extractDeps(node: AstNode): string[] {
  const deps = new Set<string>();
  const walk = (n: AstNode): void => {
    if (n.type === 'ref') deps.add(n.name);
    else if (n.type === 'bin') { walk(n.left); walk(n.right); }
    else if (n.type === 'unary') walk(n.node);
    else if (n.type === 'call') n.args.forEach(walk);
  };
  walk(node);
  return [...deps];
}

/** 解析表达式字符串 → AST */
export function parseExpr(src: string): AstNode {
  return new Parser(tokenize(src)).parse();
}
