/** Ordered Native Prelude inputs and tool-result provenance; metadata never grants replay authority. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { ToolResultContractMetadata } from './tool-result-contract.ts';

export const PRELUDE_SOURCE_VERSION = 'prelude-source-v1' as const;
export interface PreludeToolCallManifest {
  readonly id: string; readonly name: string; readonly argumentsDigest: string; readonly argumentsLength: number;
}
export interface PreludeMessageManifest {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly contentDigest: string | null; readonly contentLength: number;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly PreludeToolCallManifest[];
  readonly resultDigest?: string; readonly resultLength?: number;
}
export interface PreludeRequestManifest {
  readonly semanticDigest: string;
  readonly messages: readonly PreludeMessageManifest[];
  readonly toolSetDigest: string; readonly toolChoiceDigest: string;
  readonly temperature: number; readonly maxOutputTokens: number;
}
export interface PreludeResponseManifest {
  readonly responseDigest: string;
  readonly contentDigest: string | null; readonly contentLength: number;
  readonly finishReason: string; readonly toolCalls: readonly PreludeToolCallManifest[];
}
export interface PreludeSourceStep {
  readonly ordinal: number; readonly request: PreludeRequestManifest; readonly response: PreludeResponseManifest;
}
export interface PreludeSourceToolResult {
  readonly stepOrdinal: number; readonly callOrdinal: number;
  readonly toolCallId: string; readonly toolName: string; readonly metadata: ToolResultContractMetadata;
}
export interface PreludeSourceManifest {
  readonly sourceVersion: typeof PRELUDE_SOURCE_VERSION;
  readonly initialRequestDigest: string;
  readonly steps: readonly PreludeSourceStep[];
  readonly toolResults: readonly PreludeSourceToolResult[];
  readonly evidenceCarrier: ToolResultContractMetadata;
  readonly traceDigest: string;
}

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const NAME = /^[a-z][a-z0-9_]{0,79}$/u;
const TOOL_PREFIX = 'UNTRUSTED_TOOL_RESULT\n';
function invalid(): never { throw new Error('prelude-source-invalid'); }
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
function utf16(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf16le').digest('hex')}`;
}
function own(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) invalid();
    const field = descriptors[key]!;
    if (!field.enumerable || !Object.hasOwn(field, 'value')) invalid();
  }
  if (required.some(key => !Object.hasOwn(descriptors, key))) invalid();
  return Object.fromEntries(Object.keys(descriptors).map(key => [key, descriptors[key]!.value]));
}
function list(value: unknown, maximum = 128, minimum = 0): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) invalid(); return field.value;
  });
}
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
function count(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(); return Number(value);
}
function text(value: unknown, max = 2_097_152): string {
  if (typeof value !== 'string' || value.length > max) invalid(); return value;
}
function token(value: unknown, name = false, allowEmpty = false): string {
  const result = text(value, name ? 80 : 160);
  if (!(allowEmpty && result === '') && !(name ? NAME : ID).test(result)) invalid(); return result;
}
function content(value: unknown): { contentDigest: string | null; contentLength: number } {
  if (value === null) return { contentDigest: null, contentLength: 0 };
  const result = text(value); return { contentDigest: digest(result), contentLength: result.length };
}
function parsedContent(value: Record<string, unknown>): { contentDigest: string | null; contentLength: number } {
  const length = count(value.contentLength);
  if (value.contentDigest === null) { if (length !== 0) invalid(); return { contentDigest: null, contentLength: 0 }; }
  return { contentDigest: hash(value.contentDigest), contentLength: length };
}
function rawCall(value: unknown, wire: boolean): { id: string; name: string; arguments: string } {
  if (!wire) {
    const call = own(value, ['id', 'name', 'arguments']);
    return { id: token(call.id, false, true), name: token(call.name, true), arguments: text(call.arguments, 32_768) };
  }
  const call = own(value, ['id', 'type', 'function']);
  const fn = own(call.function, ['name', 'arguments']);
  if (call.type !== 'function') invalid();
  return { id: token(call.id), name: token(fn.name, true), arguments: text(fn.arguments, 32_768) };
}
function callManifest(call: ReturnType<typeof rawCall>): PreludeToolCallManifest {
  return Object.freeze({ id: call.id, name: call.name, argumentsDigest: digest(call.arguments), argumentsLength: call.arguments.length });
}
function parseCall(value: unknown, allowEmpty = false): PreludeToolCallManifest {
  const call = own(value, ['id', 'name', 'argumentsDigest', 'argumentsLength']);
  const argumentsLength = count(call.argumentsLength, 1); if (argumentsLength > 32_768) invalid();
  return Object.freeze({ id: token(call.id, false, allowEmpty), name: token(call.name, true),
    argumentsDigest: hash(call.argumentsDigest), argumentsLength });
}
function captureMessage(value: unknown): PreludeMessageManifest {
  const message = own(value, ['role', 'content'], ['tool_call_id', 'tool_calls']);
  if (typeof message.role !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(message.role)) invalid();
  const identity = content(message.content);
  if (message.role === 'tool') {
    const returned = text(message.content);
    if (!returned.startsWith(TOOL_PREFIX) || message.tool_calls !== undefined || message.tool_call_id === undefined) invalid();
    const result = returned.slice(TOOL_PREFIX.length);
    return Object.freeze({ role: 'tool', ...identity, toolCallId: token(message.tool_call_id),
      resultDigest: utf16(result), resultLength: result.length });
  }
  if (message.tool_call_id !== undefined) invalid();
  if (message.role === 'assistant') {
    if (message.content !== null || message.tool_calls === undefined) invalid();
    return Object.freeze({ role: 'assistant', ...identity,
      toolCalls: Object.freeze(list(message.tool_calls, 128, 1).map(call => callManifest(rawCall(call, true)))) });
  }
  if (message.tool_calls !== undefined || typeof message.content !== 'string') invalid();
  return Object.freeze({ role: message.role as 'system' | 'user', ...identity });
}
function parseMessage(value: unknown): PreludeMessageManifest {
  const message = own(value, ['role', 'contentDigest', 'contentLength'], ['toolCallId', 'toolCalls', 'resultDigest', 'resultLength']);
  if (typeof message.role !== 'string') invalid();
  const identity = parsedContent(message);
  if (message.role === 'tool') {
    if (message.toolCalls !== undefined || message.toolCallId === undefined || identity.contentDigest === null) invalid();
    const resultLength = count(message.resultLength);
    if (identity.contentLength !== TOOL_PREFIX.length + resultLength) invalid();
    return Object.freeze({ role: 'tool', ...identity, toolCallId: token(message.toolCallId),
      resultDigest: hash(message.resultDigest), resultLength });
  }
  if (message.toolCallId !== undefined || message.resultDigest !== undefined || message.resultLength !== undefined) invalid();
  if (message.role === 'assistant') {
    if (identity.contentDigest !== null || message.toolCalls === undefined) invalid();
    return Object.freeze({ role: 'assistant', ...identity,
      toolCalls: Object.freeze(list(message.toolCalls, 128, 1).map(call => parseCall(call))) });
  }
  if (!['system', 'user'].includes(message.role) || identity.contentDigest === null || message.toolCalls !== undefined) invalid();
  return Object.freeze({ role: message.role as 'system' | 'user', ...identity });
}
/** Native request identity deliberately excludes the server-owned model selection only. */
export function capturePreludeRequest(value: unknown): PreludeRequestManifest {
  const request = own(value, ['messages', 'tools', 'tool_choice', 'temperature', 'max_tokens'], ['model']);
  const messages = Object.freeze(list(request.messages, 256, 2).map(captureMessage));
  if (messages[0]!.role !== 'system' || request.tool_choice !== 'auto'
    || typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)) invalid();
  const maxOutputTokens = count(request.max_tokens, 1);
  const tools = cloneJson(request.tools);
  if (!Array.isArray(tools)) invalid();
  const { model: ignored, ...semantic } = request; void ignored;
  // cloneJson rejects executable nested values before JSON serialization.
  const semanticDigest = digest(cloneJson(semantic));
  return Object.freeze({ semanticDigest, messages, toolSetDigest: digest(tools), toolChoiceDigest: digest(request.tool_choice),
    temperature: request.temperature, maxOutputTokens });
}
function parseRequest(value: unknown): PreludeRequestManifest {
  const request = own(value, ['semanticDigest', 'messages', 'toolSetDigest', 'toolChoiceDigest', 'temperature', 'maxOutputTokens']);
  const messages = Object.freeze(list(request.messages, 256, 2).map(parseMessage));
  if (messages[0]!.role !== 'system' || typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)
    || request.toolChoiceDigest !== digest('auto')) invalid();
  return Object.freeze({ semanticDigest: hash(request.semanticDigest), messages, toolSetDigest: hash(request.toolSetDigest),
    toolChoiceDigest: hash(request.toolChoiceDigest), temperature: request.temperature, maxOutputTokens: count(request.maxOutputTokens, 1) });
}
export function capturePreludeResponse(value: unknown): PreludeResponseManifest {
  const response = own(value, ['content', 'toolCalls', 'finishReason'], ['usage', 'raw']);
  const contentIdentity = content(response.content);
  const rawCalls = list(response.toolCalls).map(call => rawCall(call, false));
  const finishReason = text(response.finishReason, 80);
  return Object.freeze({ responseDigest: digest({ content: response.content, toolCalls: rawCalls, finishReason }),
    ...contentIdentity, finishReason, toolCalls: Object.freeze(rawCalls.map(callManifest)) });
}
function parseResponse(value: unknown): PreludeResponseManifest {
  const response = own(value, ['responseDigest', 'contentDigest', 'contentLength', 'finishReason', 'toolCalls']);
  return Object.freeze({ responseDigest: hash(response.responseDigest), ...parsedContent(response),
    finishReason: text(response.finishReason, 80), toolCalls: Object.freeze(list(response.toolCalls).map(call => parseCall(call, true))) });
}
function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
  if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return list(value, 16_384).map(item => cloneJson(item, ancestors));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') invalid();
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      entries.push([key, cloneJson(descriptor.value, ancestors)]);
    }
    return Object.fromEntries(entries);
  } finally { ancestors.delete(value); }
}
function parseMetadata(value: unknown, scope: 'tool-result' | 'evidence-carrier'): ToolResultContractMetadata {
  const metadata = own(value, ['version', 'scope', 'state', 'sizeUnit', 'originalLength', 'returnedLength',
    'previewLength', 'maxLength', 'sourceDigest', 'digestEncoding', 'parseability']);
  const length = count(metadata.originalLength), maxLength = count(metadata.maxLength);
  if (metadata.version !== 'tool-result-contract-v1' || metadata.scope !== scope || metadata.state !== 'complete'
    || metadata.sizeUnit !== 'utf16-code-units' || metadata.digestEncoding !== 'utf16le'
    || metadata.parseability !== 'not-asserted' || count(metadata.returnedLength) !== length
    || count(metadata.previewLength) !== length || length > maxLength) invalid();
  return Object.freeze({ version: 'tool-result-contract-v1', scope, state: 'complete', sizeUnit: 'utf16-code-units',
    originalLength: length, returnedLength: length, previewLength: length, maxLength,
    sourceDigest: hash(metadata.sourceDigest), digestEncoding: 'utf16le', parseability: 'not-asserted' });
}
function effectiveCall(call: PreludeToolCallManifest, stepOrdinal: number, callOrdinal: number): PreludeToolCallManifest {
  return Object.freeze({ ...call, id: call.id || `call-${stepOrdinal - 1}-${callOrdinal - 1}` });
}
function normalizedSteps(value: unknown): readonly PreludeSourceStep[] {
  return Object.freeze(list(value, 128, 1).map((entry, index) => {
    const step = own(entry, ['ordinal', 'request', 'response']);
    if (count(step.ordinal, 1) !== index + 1) invalid();
    return Object.freeze({ ordinal: index + 1, request: parseRequest(step.request), response: parseResponse(step.response) });
  }));
}
function validateChain(steps: readonly PreludeSourceStep[], results: readonly PreludeSourceToolResult[]): void {
  const first = steps[0]!.request;
  if (first.messages.slice(1).some(message => message.role !== 'user')) invalid();
  let resultOffset = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    if (step.request.toolSetDigest !== first.toolSetDigest || step.request.toolChoiceDigest !== first.toolChoiceDigest
      || step.request.temperature !== first.temperature) invalid();
    const calls = step.response.toolCalls.map((call, callIndex) => effectiveCall(call, step.ordinal, callIndex + 1));
    if (new Set(calls.map(call => call.id)).size !== calls.length) invalid();
    const rows = results.slice(resultOffset, resultOffset + calls.length); resultOffset += calls.length;
    if (rows.length !== calls.length) invalid();
    rows.forEach((row, callIndex) => {
      const call = calls[callIndex]!;
      if (row.stepOrdinal !== step.ordinal || row.callOrdinal !== callIndex + 1
        || row.toolCallId !== call.id || row.toolName !== call.name) invalid();
    });
    const next = steps[index + 1];
    if (!next) continue;
    if (!calls.length || next.request.messages.length !== step.request.messages.length + 1 + calls.length) invalid();
    if (JSON.stringify(next.request.messages.slice(0, step.request.messages.length)) !== JSON.stringify(step.request.messages)) invalid();
    const assistant = next.request.messages[step.request.messages.length]!;
    if (assistant.role !== 'assistant' || assistant.contentDigest !== null
      || JSON.stringify(assistant.toolCalls) !== JSON.stringify(calls)) invalid();
    calls.forEach((call, callIndex) => {
      const message = next.request.messages[step.request.messages.length + callIndex + 1]!;
      const row = rows[callIndex]!;
      if (message.role !== 'tool' || message.toolCallId !== call.id || message.resultDigest !== row.metadata.sourceDigest
        || message.resultLength !== row.metadata.returnedLength) invalid();
    });
  }
  if (resultOffset !== results.length) invalid();
}
/** Completeness rows are step-major but concurrent read completion order is intentionally irrelevant. */
export function createPreludeSourceManifest(stepsInput: readonly PreludeSourceStep[], completeness: unknown): PreludeSourceManifest {
  const steps = normalizedSteps(stepsInput);
  const completed = own(completeness, ['state', 'toolResults', 'evidenceCarrier']);
  if (completed.state !== 'complete') invalid();
  const pending = list(completed.toolResults).map(value => {
    const result = own(value, ['toolCallId', 'toolName', 'metadata']);
    return { toolCallId: token(result.toolCallId), toolName: token(result.toolName, true), metadata: parseMetadata(result.metadata, 'tool-result') };
  });
  let offset = 0;
  const toolResults: PreludeSourceToolResult[] = [];
  for (const step of steps) {
    const calls = step.response.toolCalls.map((call, index) => effectiveCall(call, step.ordinal, index + 1));
    const group = pending.slice(offset, offset + calls.length); offset += calls.length;
    if (group.length !== calls.length) invalid();
    const used = new Set<number>();
    calls.forEach((call, index) => {
      const found = group.findIndex((row, rowIndex) => !used.has(rowIndex) && row.toolCallId === call.id && row.toolName === call.name);
      if (found < 0) invalid(); used.add(found);
      toolResults.push(Object.freeze({ stepOrdinal: step.ordinal, callOrdinal: index + 1, ...group[found]! }));
    });
  }
  if (offset !== pending.length) invalid();
  const evidenceCarrier = parseMetadata(completed.evidenceCarrier, 'evidence-carrier');
  validateChain(steps, toolResults);
  const core = { sourceVersion: PRELUDE_SOURCE_VERSION, initialRequestDigest: steps[0]!.request.semanticDigest,
    steps, toolResults: Object.freeze(toolResults), evidenceCarrier };
  return Object.freeze({ ...core, traceDigest: digest(core) });
}
/** A retained trace validates itself and its ordered links; it never reconstructs source text or a Lease. */
export function parsePreludeSourceManifest(value: unknown): PreludeSourceManifest {
  const manifest = own(value, ['sourceVersion', 'initialRequestDigest', 'steps', 'toolResults', 'evidenceCarrier', 'traceDigest']);
  if (manifest.sourceVersion !== PRELUDE_SOURCE_VERSION) invalid();
  const steps = normalizedSteps(manifest.steps);
  if (hash(manifest.initialRequestDigest) !== steps[0]!.request.semanticDigest) invalid();
  const toolResults = Object.freeze(list(manifest.toolResults).map(value => {
    const row = own(value, ['stepOrdinal', 'callOrdinal', 'toolCallId', 'toolName', 'metadata']);
    return Object.freeze({ stepOrdinal: count(row.stepOrdinal, 1), callOrdinal: count(row.callOrdinal, 1),
      toolCallId: token(row.toolCallId), toolName: token(row.toolName, true), metadata: parseMetadata(row.metadata, 'tool-result') });
  }));
  const evidenceCarrier = parseMetadata(manifest.evidenceCarrier, 'evidence-carrier');
  validateChain(steps, toolResults);
  const core = { sourceVersion: PRELUDE_SOURCE_VERSION, initialRequestDigest: steps[0]!.request.semanticDigest,
    steps, toolResults, evidenceCarrier };
  const traceDigest = digest(core);
  if (hash(manifest.traceDigest) !== traceDigest) invalid();
  return Object.freeze({ ...core, traceDigest });
}
