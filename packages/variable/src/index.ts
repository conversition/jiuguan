export { VariableManager, SCOPE_RANK } from './vms.ts';
export type { VarDecl, RegisterInput, EvalResult } from './vms.ts';
export { parseExpr, evaluate, extractDeps, WHITELIST_FUNCS } from './dsl.ts';
export type { AstNode, VarValue } from './dsl.ts';
