/**
 * memory 包 - Embedding Provider 抽象（审查 §2.3/§6：替换 hash 伪向量）
 * 两级：TransformersProvider（本地 bge 中文模型，真实语义）/ HashProvider（轻量兜底，无依赖）
 * 检索通道 B 通过注入 provider 使用向量（06/05 设计：vec_memory BLOB + 余弦全扫）
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly dims: number;
  /** 单文本向量 */
  embed(text: string): Promise<number[]>;
  /** 批量向量（向量化管线用） */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/** 轻量兜底：字符 n-gram hash 向量（无依赖、确定性；语义弱于 bge，作为 fallback） */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash-ngram';
  readonly dims = 256;
  private cache = new Map<string, number[]>();

  constructor(private ngram = 2) {}

  embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return Promise.resolve(cached);
    const v = new Array<number>(this.dims).fill(0);
    // 字符 n-gram 统计 + 位置衰减（比 64 维 charCode 桶语义强）
    const grams: string[] = [];
    for (let i = 0; i + this.ngram <= text.length; i++) grams.push(text.slice(i, i + this.ngram));
    for (const g of grams) {
      let h = 0;
      for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
      v[h % this.dims] += 1;
    }
    // L2 归一化
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    const out = v.map((x) => x / norm);
    this.cache.set(text, out);
    return Promise.resolve(out);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** 本地 bge 中文模型（transformers.js / ONNX）——真实语义 embedding */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'bge';
  readonly dims: number;
  private pipe: unknown = null;
  private cache = new Map<string, number[]>();

  constructor(
    private modelName = 'Xenova/bge-small-zh-v1.5',
  ) {
    // bge-small-zh-v1.5: 512 维
    this.dims = modelName.includes('large') ? 1024 : 512;
  }

  private async getPipe(): Promise<{ (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{ data: Float32Array }> }> {
    if (!this.pipe) {
      // 动态导入避免顶层依赖（无 transformers 环境时仍可 import 本模块）
      const tf = await import('@huggingface/transformers');
      // 国内网络：走 HF 镜像（可通过环境变量 JG_HF_MIRROR 覆盖）
      const mirror = process.env.JG_HF_MIRROR ?? 'https://hf-mirror.com';
      try {
        tf.env.remoteHost = mirror;
        tf.env.remotePathTemplate = '{model}/resolve/{revision}/';
      } catch { /* env 配置失败忽略 */ }
      const { pipeline } = tf;
      this.pipe = await pipeline('feature-extraction', this.modelName, { dtype: 'q8' });
    }
    return this.pipe as never;
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const [batch] = await this.embedBatch([text]);
    this.cache.set(text, batch);
    return batch;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipe();
    const out: number[][] = [];
    // 分批（每批 32 条，控制内存）
    for (let i = 0; i < texts.length; i += 32) {
      const chunk = texts.slice(i, i + 32);
      const res = await pipe(chunk, { pooling: 'mean', normalize: true });
      const data = res.data as Float32Array;
      const dim = this.dims;
      for (let j = 0; j < chunk.length; j++) {
        out.push(Array.from(data.slice(j * dim, (j + 1) * dim)));
      }
    }
    return out;
  }
}

/** 工厂：优先 transformers，失败回落 hash */
export async function createEmbeddingProvider(useLocalBge = true): Promise<EmbeddingProvider> {
  if (useLocalBge) {
    try {
      const p = new TransformersEmbeddingProvider();
      await p.embed('测试'); // 加载验证
      return p;
    } catch (e) {
      console.warn(`[embedding] bge 加载失败，回落 hash: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return new HashEmbeddingProvider();
}
