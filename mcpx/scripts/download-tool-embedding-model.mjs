import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const modelId = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const revision = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
const files = [
  {
    name: "config.json",
    sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
  },
  {
    name: "tokenizer.json",
    sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
  },
  {
    name: "tokenizer_config.json",
    sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2",
  },
  {
    name: "special_tokens_map.json",
    sha256: "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f",
  },
  {
    name: "onnx/model_quantized.onnx",
    sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
  },
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelRoot = resolve(
  process.env["MCPX_EMBEDDING_MODEL_PATH"] ??
    join(repositoryRoot, "packages/mcpx-server/models"),
);
const modelDirectory = resolve(modelRoot, modelId);

await mkdir(modelDirectory, { recursive: true });
await Promise.all(files.map((file) => downloadFile(file)));

async function downloadFile(file) {
  const destination = join(modelDirectory, file.name);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });

  if ((await sha256File(destination).catch(() => "")) === file.sha256) {
    console.log(`verified ${file.name}`);
    return;
  }

  const url = `https://huggingface.co/${modelId}/resolve/${revision}/${file.name}?download=true`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${file.name}: HTTP ${response.status}`);
  }

  const hash = createHash("sha256");
  const digestStream = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      digestStream,
      createWriteStream(temporary, { mode: 0o644 }),
    );
    const actualHash = hash.digest("hex");
    if (actualHash !== file.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${file.name}: expected ${file.sha256}, received ${actualHash}`,
      );
    }
    await rename(temporary, destination);
    console.log(`downloaded ${file.name}`);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
