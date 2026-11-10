// Dictation's speech model for the mock (D384, agent-dictation-m7-114): a whisper.cpp model file
// with small random weights (8 wide, one layer each side), the same as the Rust tests' synthetic
// model (src-tauri/src/speech/ggml.rs). Served at /speech/model.bin; its SHA-256 is fixed (the
// weights come from a fixed generator), so the test names it.

function synthetic(nState) {
  const parts = [];
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const f32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    parts.push(b);
  };
  i32(0x67676d6c);
  for (const v of [51865, 1500, nState, 1, 1, 448, nState, 1, 1, 80, 0]) i32(v);
  i32(80);
  i32(201);
  for (let i = 0; i < 80 * 201; i++) f32((i % 7) * 0.001);
  i32(3);
  for (const word of ["hi", " there", "!"]) {
    i32(Buffer.byteLength(word));
    parts.push(Buffer.from(word));
  }
  let seed = 1;
  const tensor = (name, ne) => {
    i32(ne.length);
    i32(Buffer.byteLength(name));
    i32(0);
    for (const d of ne) i32(d);
    parts.push(Buffer.from(name));
    const count = ne.reduce((a, b) => a * b, 1);
    const data = Buffer.alloc(count * 4);
    for (let i = 0; i < count; i++) {
      // The Rust generator's LCG (wrapping u32 arithmetic).
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      data.writeFloatLE(((seed >>> 16) / 65536 - 0.5) * 0.2, i * 4);
    }
    parts.push(data);
  };
  const s = nState;
  const block = (p, cross) => {
    const attn = (a) => {
      for (const w of ["query", "key", "value", "out"]) {
        tensor(`${p}.${a}.${w}.weight`, [s, s]);
        if (w !== "key") tensor(`${p}.${a}.${w}.bias`, [s]);
      }
      tensor(`${p}.${a}_ln.weight`, [s]);
      tensor(`${p}.${a}_ln.bias`, [s]);
    };
    attn("attn");
    if (cross) attn("cross_attn");
    tensor(`${p}.mlp_ln.weight`, [s]);
    tensor(`${p}.mlp_ln.bias`, [s]);
    tensor(`${p}.mlp.0.weight`, [s, 4 * s]);
    tensor(`${p}.mlp.0.bias`, [4 * s]);
    tensor(`${p}.mlp.2.weight`, [4 * s, s]);
    tensor(`${p}.mlp.2.bias`, [s]);
  };
  tensor("encoder.positional_embedding", [s, 1500]);
  tensor("encoder.conv1.weight", [3, 80, s]);
  tensor("encoder.conv1.bias", [1, s]);
  tensor("encoder.conv2.weight", [3, s, s]);
  tensor("encoder.conv2.bias", [1, s]);
  block("encoder.blocks.0", false);
  tensor("encoder.ln_post.weight", [s]);
  tensor("encoder.ln_post.bias", [s]);
  tensor("decoder.positional_embedding", [s, 448]);
  tensor("decoder.token_embedding.weight", [s, 51865]);
  block("decoder.blocks.0", true);
  tensor("decoder.ln.weight", [s]);
  tensor("decoder.ln.bias", [s]);
  return Buffer.concat(parts);
}

let model = null;

/** Serves the synthetic model; true when the request was one of these. */
export function handleSpeech(req, res) {
  if (req.url !== "/speech/model.bin") return false;
  model ??= synthetic(8);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": model.length,
  });
  res.end(model);
  return true;
}

// `node tests/fixtures/mock-speech.mjs`: prints the model's SHA-256 (for the test).
if (process.argv[1]?.endsWith("mock-speech.mjs")) {
  const { createHash } = await import("node:crypto");
  console.log(createHash("sha256").update(synthetic(8)).digest("hex"));
}
