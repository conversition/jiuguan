/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Validate full Interactive tool results before the runner applies its preview bound.
 */
export const INTERACTIVE_TOOL_OUTPUT_VALIDATOR_VERSION='interactive-tool-output-v1' as const;
export const INTERACTIVE_TOOL_OUTPUT_INVALID='interactive-tool-output-invalid' as const;

export interface InteractiveToolOutputContext {
    readonly input: unknown;
    /** Local value supplied to the bound codec, never a truncated preview. */
    readonly source: unknown;
    readonly state: Readonly<Record<string,unknown>>;
}

export type InteractiveToolOutputValidation={ readonly ok: true }
    |{ readonly ok: false; readonly error: typeof INTERACTIVE_TOOL_OUTPUT_INVALID };
export type InteractiveToolOutputValidator=(
    result: string,
    context: InteractiveToolOutputContext,
) => InteractiveToolOutputValidation;
export type InteractiveToolOutputCoverage='envelope-opaque-hits'|'typed-variables'
    |'typed-ack'|'typed-compute';

const VALID=Object.freeze({ ok: true } as const);
const INVALID=Object.freeze({ ok: false,error: INTERACTIVE_TOOL_OUTPUT_INVALID } as const);

function record(value: unknown): Record<string,unknown>|null {
    return typeof value==='object'&&value!==null&&!Array.isArray(value)
        ? value as Record<string,unknown>:null;
}

function exactKeys(value: Record<string,unknown>,keys: readonly string[]): boolean {
    const actual=Object.keys(value);
    return actual.length===keys.length&&keys.every((key) => Object.hasOwn(value,key));
}

function primitive(value: unknown): value is string|number|boolean {
    return typeof value==='string'||typeof value==='boolean'
        ||(typeof value==='number'&&Number.isFinite(value));
}

function skipWhitespace(value: string,offset: number): number {
    while(offset<value.length&&/[\t\n\r ]/u.test(value[offset]!)) offset++;
    return offset;
}

function stringEnd(value: string,offset: number): number {
    if(value[offset]!=='"') return -1;
    for(let index=offset+1;index<value.length;index++) {
        const character=value[index]!;
        if(character==='"') return index+1;
        if(character.charCodeAt(0)<0x20) return -1;
        if(character!=='\\') continue;
        const escape=value[++index];
        if(escape==='u') {
            if(!/^[a-fA-F0-9]{4}$/u.test(value.slice(index+1,index+5))) return -1;
            index+=4;
        } else if(escape===undefined||!'"\\/bfnrt'.includes(escape)) return -1;
    }
    return -1;
}

function numberEnd(value: string,offset: number): number {
    let index=value[offset]==='-'? offset+1:offset;
    if(value[index]==='0') index++;
    else {
        if(!/[1-9]/u.test(value[index]??'')) return -1;
        while(/[0-9]/u.test(value[++index]??'')) { /* Scan without allocating the numeric token. */ }
    }
    if(value[index]==='.') {
        if(!/[0-9]/u.test(value[++index]??'')) return -1;
        while(/[0-9]/u.test(value[++index]??'')) { /* Keep opaque numeric tokens unparsed. */ }
    }
    if(value[index]==='e'||value[index]==='E') {
        index++;
        if(value[index]==='+'||value[index]==='-') index++;
        if(!/[0-9]/u.test(value[index]??'')) return -1;
        while(/[0-9]/u.test(value[++index]??'')) { /* Keep opaque numeric tokens unparsed. */ }
    }
    return index;
}

/** Syntax-only streaming scan: opaque hits never become another potentially huge object tree. */
function jsonValueEnd(value: string,offset: number): number {
    const frames: Array<{ object: boolean; phase: number }>=[];
    let expectsValue=true;
    let index=offset;
    const completeValue=(): boolean => {
        const parent=frames.at(-1);
        if(!parent) return true;
        parent.phase=parent.object? 4:2;
        return false;
    };
    while(index<value.length) {
        index=skipWhitespace(value,index);
        const character=value[index];
        if(expectsValue) {
            expectsValue=false;
            if(character==='{'||character==='[') {
                frames.push({ object: character==='{',phase: 0 });
                index++;
                continue;
            }
            if(character==='"') index=stringEnd(value,index);
            else if(value.startsWith('true',index)) index+=4;
            else if(value.startsWith('false',index)) index+=5;
            else if(value.startsWith('null',index)) index+=4;
            else index=numberEnd(value,index);
            if(index<0) return -1;
            if(completeValue()) return index;
            continue;
        }
        const frame=frames.at(-1);
        if(!frame) return -1;
        const closing=frame.object? '}':']';
        const afterValue=frame.object? 4:2;
        if(character===closing&&(frame.phase===0||frame.phase===afterValue)) {
            frames.pop();
            index++;
            if(completeValue()) return index;
        } else if(frame.phase===afterValue&&character===',') {
            frame.phase=1;
            index++;
        } else if(frame.object&&(frame.phase===0||frame.phase===1)) {
            index=stringEnd(value,index);
            if(index<0) return -1;
            frame.phase=2;
        } else if(frame.object&&frame.phase===2&&character===':') {
            frame.phase=3;
            index++;
            expectsValue=true;
        } else if(!frame.object&&(frame.phase===0||frame.phase===1)) expectsValue=true;
        else return -1;
    }
    return -1;
}

/** The read contract binds the query and JSON envelope, not facts or the host-specific hit schema. */
export const validateInteractiveReadOutput: InteractiveToolOutputValidator=(result,context) => {
    const input=record(context.input);
    const source=record(context.source);
    if(typeof result!=='string'||!input||!source||typeof input.query!=='string'
        ||!exactKeys(source,['query','hits'])||source.query!==input.query) return INVALID;
    const prefix=`{"query":${JSON.stringify(input.query)}`;
    // JSON.stringify historically omits undefined, function, symbol, or toJSON(undefined) hits.
    if(result===`${prefix}}`) return VALID;
    const hitsPrefix=`${prefix},"hits":`;
    if(!result.startsWith(hitsPrefix)) return INVALID;
    const end=jsonValueEnd(result,hitsPrefix.length);
    return end>=0&&result.slice(end)==='}'? VALID:INVALID;
};

/** Match primitive snapshot fields without reparsing a potentially large full result. */
export const validateInteractiveVariablesOutput: InteractiveToolOutputValidator=(result,context) => {
    const source=record(context.source);
    const input=record(context.input);
    if(typeof result!=='string'||!source||!input||result[0]!=='{') return INVALID;
    const keys=input.keys;
    if(keys!==undefined&&!Array.isArray(keys)) return INVALID;
    let offset=1;
    let count=0;
    for(const [key,value] of Object.entries(source)) {
        if(!primitive(value)||(keys!==undefined&&!keys.includes(key))) return INVALID;
        const field=`${count++===0? '':','}${JSON.stringify(key)}:${JSON.stringify(value)}`;
        if(!result.startsWith(field,offset)) return INVALID;
        offset+=field.length;
    }
    return result.slice(offset)==='}'? VALID:INVALID;
};

function samePatch(input: unknown,staged: unknown): boolean {
    const left=record(input);
    const right=record(staged);
    if(!left||!right||left===right||!exactKeys(left,['operationKey','patches'])
        ||!exactKeys(right,['operationKey','patches'])||left.operationKey!==right.operationKey
        ||!Array.isArray(left.patches)||!Array.isArray(right.patches)
        ||left.patches===right.patches||left.patches.length!==right.patches.length) return false;
    return left.patches.every((item,index) => {
        const before=record(item);
        const after=record((right.patches as unknown[])[index]);
        return before!==null&&after!==null&&before!==after
            &&exactKeys(before,['path','value'])&&exactKeys(after,['path','value'])
            &&typeof before.path==='string'&&primitive(before.value)
            &&before.path===after.path&&Object.is(before.value,after.value);
    });
}

export const validateInteractivePatchOutput: InteractiveToolOutputValidator=(result,context) => {
    return result==='variable-patch-staged'&&samePatch(context.input,context.state.stagedVariablePatch)
        ? VALID:INVALID;
};

function sameHint(input: unknown,staged: unknown): boolean {
    const left=record(input);
    const right=record(staged);
    return left!==null&&right!==null&&left!==right
        &&exactKeys(left,['path','value','rationale'])&&exactKeys(right,['path','value','rationale'])
        &&typeof left.path==='string'&&primitive(left.value)&&typeof left.rationale==='string'
        &&left.path===right.path&&Object.is(left.value,right.value)&&left.rationale===right.rationale;
}

export const validateInteractiveHintOutput: InteractiveToolOutputValidator=(result,context) => {
    const source=record(context.source);
    return source!==null&&exactKeys(source,['effect','proposal'])&&source.effect==='advisory-only'
        &&source.proposal===context.input&&sameHint(context.input,context.state.advisoryVariableHint)
        &&result===JSON.stringify(source)? VALID:INVALID;
};

export const validateInteractiveSandboxOutput: InteractiveToolOutputValidator=(result,context) => {
    const args=record(context.input);
    const input=record(args?.input);
    const source=record(context.source);
    if(!args||!input||!source||typeof result!=='string') return INVALID;
    if(args.action==='math.clamp'||args.action==='math.round') {
        if(!exactKeys(source,['value'])||typeof source.value!=='number'
            ||!Number.isFinite(source.value)||typeof input.value!=='number') return INVALID;
        const expected=args.action==='math.clamp'
            ? Math.max(input.min as number,Math.min(input.max as number,input.value))
            :Math.round(input.value*10**(input.digits as number))/10**(input.digits as number);
        return Object.is(source.value,expected)&&result===JSON.stringify(source)? VALID:INVALID;
    }
    if(args.action!=='text.stats'||typeof input.text!=='string'
        ||!exactKeys(source,['codePoints','utf8Bytes','lines'])) return INVALID;
    return source.codePoints===[...input.text].length
        &&source.utf8Bytes===Buffer.byteLength(input.text,'utf8')
        &&source.lines===(input.text.length===0? 0:input.text.split(/\r?\n/u).length)
        &&result===JSON.stringify(source)? VALID:INVALID;
};
