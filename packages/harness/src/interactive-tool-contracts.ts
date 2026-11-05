/**
 * @author Codex
 * @date 2026-10-15
 * @version 1.0
 * Describe the native schemas and local bindings without granting host authority.
 */
import { createHash } from 'node:crypto';
import {
    classifyInteractiveFailure,
    INTERACTIVE_FAILURE_CONTRACT_VERSION,
} from './interactive-failure-contract.ts';
import {
    INTERACTIVE_TOOL_OUTPUT_VALIDATOR_VERSION,
    type InteractiveToolOutputCoverage,
    type InteractiveToolOutputValidator,
} from './interactive-tool-output.ts';
import {
    TOOL_RESULT_BOUND_RULE,
    TOOL_RESULT_CONTRACT_VERSION,
    TOOL_RESULT_SIZE_UNIT,
} from './tool-result-contract.ts';

export const INTERACTIVE_TOOL_CONTRACT_CATALOG_VERSION = 'interactive-tool-contract-catalog-v2' as const;
export const INTERACTIVE_TOOL_VERSION = '1' as const;

export type InteractiveToolId = 'query_memory' | 'get_worldbook' | 'get_variables'
    | 'propose_variable_patch' | 'propose_variable_hint' | 'run_sandbox_action';
export type InteractiveToolValidation = { ok: true; value: unknown } | { ok: false; error: string };

/** Only local bindings enter this builder; model declarations never supply validators or effects. */
export interface InteractiveToolContractBinding {
    readonly name: InteractiveToolId;
    readonly effect: 'read' | 'proposal' | 'deterministic-compute';
    readonly validatorRef: string;
    readonly codecRef: string;
    readonly outputValidatorRef: string;
    readonly outputCoverage: InteractiveToolOutputCoverage;
    validate(value: unknown): InteractiveToolValidation;
    encodeResult(value: unknown): string;
    validateOutput: InteractiveToolOutputValidator;
}

export interface InteractiveToolContract {
    readonly catalogVersion: typeof INTERACTIVE_TOOL_CONTRACT_CATALOG_VERSION;
    readonly toolId: InteractiveToolId;
    readonly toolVersion: typeof INTERACTIVE_TOOL_VERSION;
    /** Frozen exact declaration bytes snapshots; these never alias the Provider's runtime objects. */
    readonly nativeTool: Readonly<Record<string, unknown>>;
    readonly nativeInputSchema: Readonly<Record<string, unknown>>;
    /** SHA-256 of JSON.stringify UTF-8 bytes; object insertion order is significant. */
    readonly nativeToolDigest: string;
    readonly inputSchemaDigest: string;
    readonly inputValidator: Readonly<{
        status: 'bound';
        reference: string;
        version: '1';
        validate: InteractiveToolContractBinding['validate'];
    }>;
    readonly resultCodec: Readonly<{
        status: 'bound';
        reference: string;
        version: '1';
        encode: InteractiveToolContractBinding['encodeResult'];
    }>;
    readonly outputValidator: Readonly<{
        status: 'bound';
        reference: string;
        version: typeof INTERACTIVE_TOOL_OUTPUT_VALIDATOR_VERSION;
        coverage: InteractiveToolOutputCoverage;
        validationStage: 'complete-before-result-bound';
        opaqueContent: 'unvalidated' | 'not-applicable';
        validatesDomainFacts: false;
        validate: InteractiveToolOutputValidator;
    }>;
    readonly failureClassification: Readonly<{
        status: 'bound';
        reference: 'interactive-failure-contract:classifyInteractiveFailure';
        version: typeof INTERACTIVE_FAILURE_CONTRACT_VERSION;
        classify: typeof classifyInteractiveFailure;
        autoRetry: false;
        executionOwner: 'interactive-runner';
    }>;
    readonly effect: 'read' | 'staged-proposal' | 'advisory-proposal' | 'deterministic-compute';
    readonly hostAuthorization: Readonly<{
        status: 'host-owned';
        references: readonly string[];
        grantsAuthority: false;
    }>;
    readonly retry: Readonly<{
        mode: 'read-no-idempotency-key' | 'deterministic-no-idempotency-key'
        | 'single-stage-no-retry-guarantee' | 'single-advisory-no-retry-guarantee';
        operationKey: 'required-proposal-identifier' | 'not-applicable';
        reconciliation: 'host-revision-and-turn-job-fence' | 'host-read-snapshot'
        | 'run-local-advisory-state' | 'pure-computation';
        guaranteesRetryIdempotency: false;
    }>;
    readonly resultSize: Readonly<{
        contractVersion: typeof TOOL_RESULT_CONTRACT_VERSION;
        rule: typeof TOOL_RESULT_BOUND_RULE;
        sizeUnit: typeof TOOL_RESULT_SIZE_UNIT;
        policyReference: 'interactive-runner:effective-policy.maxToolResultChars';
        defaultMaxLength: number;
        zeroAllowed: false;
        enforcementOwner: 'interactive-runner';
    }>;
    readonly pending: readonly ('opaque-read-content-validation' | 'retry-idempotency-guarantee')[];
}

type ToolSemantics = Pick<InteractiveToolContract, 'effect' | 'retry'> & {
    readonly authorizationReferences: readonly string[];
};

const COMMON_AUTHORIZATION_REFERENCES = Object.freeze([
    'interactive-runner:admission-and-effective-native-tool-allowlist',
    'interactive-runner:call-id-and-local-input-validation',
]);

const READ_RETRY = Object.freeze({
    mode: 'read-no-idempotency-key',
    operationKey: 'not-applicable',
    reconciliation: 'host-read-snapshot',
    guaranteesRetryIdempotency: false,
} as const);

const TOOL_SEMANTICS: Readonly<Record<InteractiveToolId, ToolSemantics>> = Object.freeze({
    query_memory: {
        effect: 'read', retry: READ_RETRY,
        authorizationReferences: ['interactive-tools:readMemory-host-callback'],
    },
    get_worldbook: {
        effect: 'read', retry: READ_RETRY,
        authorizationReferences: ['interactive-tools:readWorldbook-host-callback'],
    },
    get_variables: {
        effect: 'read', retry: READ_RETRY,
        authorizationReferences: ['interactive-tools:variables-host-snapshot'],
    },
    propose_variable_patch: {
        effect: 'staged-proposal',
        authorizationReferences: [
            'interactive-tools:effective-variable-policy',
            'interactive-tools:single-staged-variable-patch',
            'interactive-output-contract:validateInteractiveVariablePatchForCommit',
            'session:revision-and-turn-job-fence',
        ],
        retry: Object.freeze({
            mode: 'single-stage-no-retry-guarantee',
            operationKey: 'required-proposal-identifier',
            reconciliation: 'host-revision-and-turn-job-fence',
            guaranteesRetryIdempotency: false,
        }),
    },
    propose_variable_hint: {
        effect: 'advisory-proposal',
        authorizationReferences: ['interactive-tools:single-run-local-advisory-hint'],
        retry: Object.freeze({
            mode: 'single-advisory-no-retry-guarantee',
            operationKey: 'not-applicable',
            reconciliation: 'run-local-advisory-state',
            guaranteesRetryIdempotency: false,
        }),
    },
    run_sandbox_action: {
        effect: 'deterministic-compute',
        authorizationReferences: ['interactive-tools:fixed-pure-action-allowlist'],
        retry: Object.freeze({
            mode: 'deterministic-no-idempotency-key',
            operationKey: 'not-applicable',
            reconciliation: 'pure-computation',
            guaranteesRetryIdempotency: false,
        }),
    },
});

function jsonDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function freezeDeclarationSnapshot<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    for (const child of Object.values(value)) freezeDeclarationSnapshot(child);
    return Object.freeze(value);
}

/** Bind only schemas present in this exact effective Provider projection, in its original order. */
export function buildInteractiveToolContractCatalog(
    nativeTools: readonly Readonly<Record<string, unknown>>[],
    bindings: readonly InteractiveToolContractBinding[],
    defaultMaxLength: number,
): readonly InteractiveToolContract[] {
    const byName = new Map(bindings.map((binding) => [binding.name, binding]));
    if (byName.size !== bindings.length) throw new Error('interactive-tool-contract-binding-duplicate');
    if (!Number.isSafeInteger(defaultMaxLength) || defaultMaxLength < 1) {
        throw new Error('interactive-tool-contract-result-limit-invalid');
    }
    const seen = new Set<string>();
    return Object.freeze(nativeTools.map((nativeTool) => {
        const declaration = nativeTool.function as { name?: unknown; parameters?: unknown } | undefined;
        const binding = typeof declaration?.name === 'string'
            ? byName.get(declaration.name as InteractiveToolId) : undefined;
        const schema = declaration?.parameters;
        if (!binding || seen.has(binding.name) || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
            throw new Error('interactive-tool-contract-native-binding-mismatch');
        }
        seen.add(binding.name);
        const semantics = TOOL_SEMANTICS[binding.name];
        const expectedEffect = semantics.effect.endsWith('proposal') ? 'proposal' : semantics.effect;
        if (binding.effect !== expectedEffect) throw new Error('interactive-tool-contract-effect-mismatch');
        const nativeSnapshot = freezeDeclarationSnapshot(structuredClone(nativeTool));
        const schemaSnapshot = (nativeSnapshot.function as {
            parameters: Readonly<Record<string, unknown>>;
        }).parameters;
        return Object.freeze({
            catalogVersion: INTERACTIVE_TOOL_CONTRACT_CATALOG_VERSION,
            toolId: binding.name,
            toolVersion: INTERACTIVE_TOOL_VERSION,
            nativeTool: nativeSnapshot,
            nativeInputSchema: schemaSnapshot,
            nativeToolDigest: jsonDigest(nativeSnapshot),
            inputSchemaDigest: jsonDigest(schemaSnapshot),
            inputValidator: Object.freeze({
                status: 'bound', reference: binding.validatorRef, version: '1', validate: binding.validate,
            } as const),
            resultCodec: Object.freeze({
                status: 'bound', reference: binding.codecRef, version: '1', encode: binding.encodeResult,
            } as const),
            outputValidator: Object.freeze({
                status: 'bound', reference: binding.outputValidatorRef,
                version: INTERACTIVE_TOOL_OUTPUT_VALIDATOR_VERSION,
                coverage: binding.outputCoverage,
                validationStage: 'complete-before-result-bound',
                opaqueContent: binding.outputCoverage === 'envelope-opaque-hits' ? 'unvalidated' : 'not-applicable',
                validatesDomainFacts: false, validate: binding.validateOutput,
            } as const),
            failureClassification: Object.freeze({
                status: 'bound', reference: 'interactive-failure-contract:classifyInteractiveFailure',
                version: INTERACTIVE_FAILURE_CONTRACT_VERSION, classify: classifyInteractiveFailure,
                autoRetry: false, executionOwner: 'interactive-runner',
            } as const),
            effect: semantics.effect,
            hostAuthorization: Object.freeze({
                status: 'host-owned', grantsAuthority: false,
                references: Object.freeze([...COMMON_AUTHORIZATION_REFERENCES, ...semantics.authorizationReferences]),
            } as const),
            retry: semantics.retry,
            resultSize: Object.freeze({
                contractVersion: TOOL_RESULT_CONTRACT_VERSION,
                rule: TOOL_RESULT_BOUND_RULE,
                sizeUnit: TOOL_RESULT_SIZE_UNIT,
                policyReference: 'interactive-runner:effective-policy.maxToolResultChars',
                defaultMaxLength,
                zeroAllowed: false,
                enforcementOwner: 'interactive-runner',
            } as const),
            pending: Object.freeze(binding.effect === 'proposal'
                ? ['retry-idempotency-guarantee'] as const
                : binding.outputCoverage === 'envelope-opaque-hits'
                    ? ['opaque-read-content-validation'] as const : []),
        });
    }));
}
