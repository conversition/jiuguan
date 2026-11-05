/** Public provider-client transport and types used by cross-workspace test harnesses. */
export { AbortTurnError, OpenAICompatibleClient, OpenAICompatibleError, readOfficialDeepSeekModelEvidence, officialDeepSeekRequestDigest } from '../src/client.ts';
export type {
  ChatCompletionClient,
  ChatProviderCall,
  ChatRequest,
  ChatResponse,
  ChatToolArgumentDelta,
} from '../src/client.ts';
