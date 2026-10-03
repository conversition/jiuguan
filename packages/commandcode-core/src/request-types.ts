export interface CacheControl {
  type?: string;
  [key: string]: unknown;
}

export interface ChatContentPart {
  type?: string;
  text?: unknown;
  content?: unknown;
  image_url?: { url?: unknown } | unknown;
  cache_control?: CacheControl | unknown;
  [key: string]: unknown;
}

export interface ChatToolCall {
  id?: unknown;
  type?: unknown;
  function?: {
    name?: unknown;
    arguments?: unknown;
    [key: string]: unknown;
  } | unknown;
  [key: string]: unknown;
}

export interface ChatMessage {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: ChatToolCall[] | unknown;
  tool_call_id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

export interface ChatToolDefinition {
  type?: unknown;
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  function?: {
    name?: unknown;
    description?: unknown;
    parameters?: unknown;
    [key: string]: unknown;
  } | unknown;
  [key: string]: unknown;
}

export interface ChatRequest {
  model?: unknown;
  messages?: ChatMessage[] | unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop?: unknown;
  user?: unknown;
  tools?: ChatToolDefinition[] | unknown;
  stream?: unknown;
  reasoning_effort?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  prompt_cache_key?: unknown;
  [key: string]: unknown;
}

export interface CommandCodeDeviceProfile {
  projectDir: string;
  platform: string;
}

export interface BuildCommandCodeRequestOptions {
  deviceProfile: CommandCodeDeviceProfile;
  date: string;
  cliMode?: string;
  emptySystemPlaceholder?: boolean;
}

export interface CommandCodeTextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
}

export interface CommandCodeWireRequest {
  config: {
    workingDir: string;
    date: string;
    environment: string;
    structure: unknown[];
    isGitRepo: false;
    currentBranch: string;
    mainBranch: string;
    gitStatus: string;
    recentCommits: unknown[];
  };
  memory: null;
  taste: null;
  skills: null;
  permissionMode: 'standard';
  mode: string;
  params: {
    model: string;
    messages: Array<Record<string, unknown>>;
    max_tokens: number;
    stream: true;
    system?: CommandCodeTextBlock[];
    temperature?: unknown;
    reasoning_effort?: unknown;
    tools: Array<Record<string, unknown>>;
    tool_choice?: unknown;
    parallel_tool_calls?: unknown;
  };
}

export interface AnthropicRequest {
  model?: unknown;
  system?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  stop_sequences?: unknown;
  metadata?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
}

export interface ResponsesRequest {
  model?: unknown;
  instructions?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  parallel_tool_calls?: unknown;
  reasoning?: unknown;
  [key: string]: unknown;
}

export interface RequestConversionWarning {
  code: 'unknown_responses_input_item';
  itemType?: string;
}

export interface ConvertResponsesOptions {
  newCallId: () => string;
  onWarning?: (warning: RequestConversionWarning) => void;
}
