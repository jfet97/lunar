import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PreTrainedTokenizer } from "@huggingface/transformers";

export const EMBEDDING_MODEL_ID =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_MODEL_REVISION =
  "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const EMBEDDING_VECTOR_SIZE = 384;

const MODEL_MAX_LENGTH = 128;
const WASM_MODEL_PATH = "onnx/model_quantized.onnx";
const LOCAL_MODEL_FILES = new Set([
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
]);
const embeddingRequire = createRequire(resolve(process.cwd(), "package.json"));

type EncodedTensor = {
  type: string;
  data: BigInt64Array | Int32Array;
  dims: number[];
};

type EncodedBatch = Record<string, EncodedTensor>;

type OrtTensor = {
  data: ArrayLike<number | bigint>;
  dims: number[];
};

type OrtSession = {
  inputNames: string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
};

type OrtRuntime = {
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => OrtTensor;
  InferenceSession: {
    create(
      model: Uint8Array,
      options: { executionProviders: ["wasm"] },
    ): Promise<OrtSession>;
  };
  env: {
    wasm: {
      numThreads: number;
      proxy: boolean;
      wasmPaths: { mjs: string; wasm: string };
    };
  };
};

type TransformersWebModule = {
  AutoTokenizer: typeof import("@huggingface/transformers").AutoTokenizer;
  env: typeof import("@huggingface/transformers").env;
};

type EmbeddingRuntime = {
  tokenizer: PreTrainedTokenizer;
  session: OrtSession;
  onnxruntime: OrtRuntime;
};

let runtime: Promise<EmbeddingRuntime> | undefined;
let inferenceQueue: Promise<unknown> = Promise.resolve();

export function embedToolTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return Promise.resolve([]);
  const task = inferenceQueue.then(() => embed(texts));
  inferenceQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export async function prewarmToolEmbeddings(): Promise<void> {
  await getRuntime();
}

async function embed(texts: string[]): Promise<number[][]> {
  const loaded = await getRuntime();
  const encoded = loaded.tokenizer(texts, {
    padding: true,
    truncation: true,
    max_length: MODEL_MAX_LENGTH,
  }) as EncodedBatch;
  const feeds: Record<string, OrtTensor> = {};
  for (const name of loaded.session.inputNames) {
    const source = encoded[name];
    if (
      !source ||
      source.type !== "int64" ||
      !(source.data instanceof BigInt64Array)
    ) {
      throw new Error(`Tokenizer returned an unsupported tensor for ${name}`);
    }
    feeds[name] = new loaded.onnxruntime.Tensor(
      "int64",
      source.data,
      source.dims,
    );
  }

  const output = await loaded.session.run(feeds);
  const hidden = output["last_hidden_state"];
  const mask = encoded["attention_mask"];
  if (!hidden || !mask || mask.dims.length !== 2 || hidden.dims.length !== 3) {
    throw new Error("Embedding model returned an invalid output shape");
  }
  const [batchSize, sequenceLength] = mask.dims;
  const [outputBatchSize, outputSequenceLength, width] = hidden.dims;
  if (
    batchSize === undefined ||
    sequenceLength === undefined ||
    outputBatchSize !== batchSize ||
    outputSequenceLength !== sequenceLength ||
    width !== EMBEDDING_VECTOR_SIZE ||
    batchSize !== texts.length
  ) {
    throw new Error("Embedding model returned an unexpected output shape");
  }

  const maskValues = mask.data;
  const hiddenValues = hidden.data;
  const vectors: number[][] = [];
  for (let batch = 0; batch < batchSize; batch += 1) {
    const vector = Array<number>(width).fill(0);
    let tokenCount = 0;
    for (let token = 0; token < sequenceLength; token += 1) {
      const maskIndex = batch * sequenceLength + token;
      if (Number(maskValues[maskIndex]) === 0) continue;
      tokenCount += 1;
      const hiddenOffset = maskIndex * width;
      for (let dimension = 0; dimension < width; dimension += 1) {
        vector[dimension] =
          (vector[dimension] ?? 0) +
          Number(hiddenValues[hiddenOffset + dimension]);
      }
    }
    if (tokenCount === 0)
      throw new Error("Tokenizer returned an empty sequence");
    let normSquared = 0;
    for (let dimension = 0; dimension < width; dimension += 1) {
      const value = (vector[dimension] ?? 0) / tokenCount;
      vector[dimension] = value;
      normSquared += value * value;
    }
    const norm = Math.sqrt(normSquared);
    if (!Number.isFinite(norm) || norm === 0)
      throw new Error("Embedding model returned a zero vector");
    vectors.push(vector.map((value) => value / norm));
  }
  return vectors;
}

async function getRuntime(): Promise<EmbeddingRuntime> {
  if (!runtime) {
    const pending = initializeRuntime();
    runtime = pending.catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
  }
  return runtime;
}

async function initializeRuntime(): Promise<EmbeddingRuntime> {
  const webBundle = join(
    dirname(embeddingRequire.resolve("@huggingface/transformers")),
    "transformers.web.js",
  );
  const runtimeSpecifier = "onnxruntime-web";
  const onnxruntime = (await import(runtimeSpecifier)) as OrtRuntime;
  Object.defineProperty(globalThis, Symbol.for("onnxruntime"), {
    configurable: true,
    value: onnxruntime,
  });
  const transformers = (await import(
    pathToFileURL(webBundle).href
  )) as TransformersWebModule;
  const modelRoot = resolve(
    process.env["MCPX_EMBEDDING_MODEL_PATH"] ?? "models",
  );
  const modelDirectory = resolve(modelRoot, EMBEDDING_MODEL_ID);

  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = `${modelRoot}/`;
  transformers.env.useBrowserCache = false;
  transformers.env.useFSCache = false;
  transformers.env.useCustomCache = true;
  const modelPrefix = `${transformers.env.localModelPath}${EMBEDDING_MODEL_ID}/`;
  transformers.env.customCache = {
    async match(request: RequestInfo | URL): Promise<Response | undefined> {
      const key =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (!key.startsWith(modelPrefix)) return undefined;
      const fileName = key.slice(modelPrefix.length);
      if (!LOCAL_MODEL_FILES.has(fileName)) return undefined;
      try {
        return new Response(await readFile(join(modelDirectory, fileName)));
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
      }
    },
    async put(): Promise<void> {},
  };

  const tokenizer = await transformers.AutoTokenizer.from_pretrained(
    EMBEDDING_MODEL_ID,
    {
      local_files_only: true,
      revision: EMBEDDING_MODEL_REVISION,
    },
  );
  onnxruntime.env.wasm.numThreads = 1;
  onnxruntime.env.wasm.proxy = false;
  const wasmDirectory = dirname(embeddingRequire.resolve("onnxruntime-web"));
  onnxruntime.env.wasm.wasmPaths = {
    mjs: pathToFileURL(join(wasmDirectory, "ort-wasm-simd-threaded.mjs")).href,
    wasm: pathToFileURL(join(wasmDirectory, "ort-wasm-simd-threaded.wasm"))
      .href,
  };
  const session = await onnxruntime.InferenceSession.create(
    new Uint8Array(await readFile(join(modelDirectory, WASM_MODEL_PATH))),
    { executionProviders: ["wasm"] },
  );
  return { tokenizer, session, onnxruntime };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
