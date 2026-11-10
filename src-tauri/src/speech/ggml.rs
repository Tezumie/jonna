//! whisper.cpp's model files (`ggml-<size>[-q5_1].bin`, MIT, D384): the hyperparameters, the mel
//! filters, the vocabulary as raw bytes, then the tensors. Read into candle's quantized tensors
//! under the names candle's Whisper layers look up (Hugging Face's, `model.encoder.layers.0…`).
//! Compressed weights (q5_1, q4…) are widened to f16 on load: candle's CPU code for those formats
//! is several times slower than its f16 matrix products (measured: 14 s against 3 s for a
//! sentence with the base model).

use candle_core::quantized::{ggml_file::qtensor_from_ggml, GgmlDType, QTensor};
use candle_core::Device;

use crate::error::{Error, Result};

const MAGIC: u32 = 0x6767_6d6c; // "ggml"

/// The file's hyperparameters, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hparams {
    pub n_vocab: usize,
    pub n_audio_ctx: usize,
    pub n_audio_state: usize,
    pub n_audio_head: usize,
    pub n_audio_layer: usize,
    pub n_text_ctx: usize,
    pub n_text_state: usize,
    pub n_text_head: usize,
    pub n_text_layer: usize,
    pub n_mels: usize,
}

pub struct WhisperFile {
    pub hparams: Hparams,
    /// `n_mels` rows of `n_fft` weights (the file's own filters, so they match its training).
    pub filters: Vec<f32>,
    /// Token id → its bytes (the text tokens; the special ones come after).
    pub vocab: Vec<Vec<u8>>,
    pub tensors: Vec<(String, QTensor)>,
}

fn bad(what: &str) -> Error {
    Error::Invalid(format!("The speech model file is damaged ({what})."))
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).filter(|e| *e <= self.bytes.len());
        let end = end.ok_or_else(|| bad("it ends early"))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn i32(&mut self) -> Result<i32> {
        let b = self.take(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    /// A count or size: never negative, and bounded so a bad file can't ask for terabytes.
    fn size(&mut self, max: usize) -> Result<usize> {
        let v = self.i32()?;
        usize::try_from(v)
            .ok()
            .filter(|v| *v <= max)
            .ok_or_else(|| bad("a size is out of range"))
    }
    fn done(&self) -> bool {
        self.at >= self.bytes.len()
    }
}

/// whisper.cpp's tensor name → candle's (Hugging Face's) name.
pub fn candle_name(name: &str) -> String {
    let mut n = name.to_string();
    for (from, to) in [
        (
            "encoder.positional_embedding",
            "encoder.embed_positions.weight",
        ),
        (
            "decoder.positional_embedding",
            "decoder.embed_positions.weight",
        ),
        ("decoder.token_embedding", "decoder.embed_tokens"),
        ("encoder.ln_post.", "encoder.layer_norm."),
        ("decoder.ln.", "decoder.layer_norm."),
        (".blocks.", ".layers."),
        (".cross_attn_ln.", ".encoder_attn_layer_norm."),
        (".cross_attn.", ".encoder_attn."),
        (".attn_ln.", ".self_attn_layer_norm."),
        (".attn.", ".self_attn."),
        (".query.", ".q_proj."),
        (".key.", ".k_proj."),
        (".value.", ".v_proj."),
        (".out.", ".out_proj."),
        (".mlp_ln.", ".final_layer_norm."),
        (".mlp.0.", ".fc1."),
        (".mlp.2.", ".fc2."),
    ] {
        n = n.replace(from, to);
    }
    format!("model.{n}")
}

fn dtype(code: i32) -> Result<GgmlDType> {
    Ok(match code {
        0 => GgmlDType::F32,
        1 => GgmlDType::F16,
        2 => GgmlDType::Q4_0,
        3 => GgmlDType::Q4_1,
        6 => GgmlDType::Q5_0,
        7 => GgmlDType::Q5_1,
        8 => GgmlDType::Q8_0,
        _ => return Err(bad("a tensor type isn't one this reads")),
    })
}

/// A tensor's bytes on an 8-byte boundary. candle reads them in place as f32s, f16s or blocks,
/// which must be aligned; in the file a tensor starts wherever its name ends.
struct Aligned {
    words: Vec<u64>,
    len: usize,
}

impl Aligned {
    fn copy(bytes: &[u8]) -> Self {
        let mut words = vec![0u64; bytes.len().div_ceil(8)];
        for (word, chunk) in words.iter_mut().zip(bytes.chunks(8)) {
            let mut b = [0u8; 8];
            b[..chunk.len()].copy_from_slice(chunk);
            // Native order: the words' bytes in memory are the file's bytes, in order.
            *word = u64::from_ne_bytes(b);
        }
        Self {
            words,
            len: bytes.len(),
        }
    }
}

impl std::ops::Deref for Aligned {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        // SAFETY: u64s are plain bytes with no padding; u8 needs no alignment, and `len` is at
        // most the words' size in bytes. The slice borrows `self`, so it can't outlive the words.
        unsafe { std::slice::from_raw_parts(self.words.as_ptr().cast::<u8>(), self.len) }
    }
}

fn candle_err(e: candle_core::Error) -> Error {
    Error::Invalid(format!("The speech model couldn't be read: {e}"))
}

/// Reads a whisper.cpp model from its bytes.
pub fn read(bytes: &[u8], device: &Device) -> Result<WhisperFile> {
    let mut r = Reader { bytes, at: 0 };
    if r.i32()? as u32 != MAGIC {
        return Err(Error::Invalid(
            "That isn't a whisper.cpp model file.".into(),
        ));
    }
    let mut hp = [0usize; 11];
    for v in hp.iter_mut() {
        *v = r.size(1 << 20)?;
    }
    let hparams = Hparams {
        n_vocab: hp[0],
        n_audio_ctx: hp[1],
        n_audio_state: hp[2],
        n_audio_head: hp[3],
        n_audio_layer: hp[4],
        n_text_ctx: hp[5],
        n_text_state: hp[6],
        n_text_head: hp[7],
        n_text_layer: hp[8],
        n_mels: hp[9],
    };
    if hparams.n_audio_head == 0
        || !hparams.n_audio_state.is_multiple_of(hparams.n_audio_head)
        || hparams.n_audio_state != hparams.n_text_state
        || hparams.n_audio_head != hparams.n_text_head
    {
        return Err(bad("its sizes don't fit together"));
    }
    let n_mel = r.size(1024)?;
    let n_fft = r.size(4096)?;
    let filters = r
        .take(n_mel * n_fft * 4)?
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect();
    let n_tokens = r.size(1 << 20)?;
    let mut vocab = Vec::with_capacity(n_tokens);
    for _ in 0..n_tokens {
        let len = r.size(1 << 16)?;
        vocab.push(r.take(len)?.to_vec());
    }
    let mut tensors = Vec::new();
    while !r.done() {
        let n_dims = r.size(4)?;
        let name_len = r.size(1024)?;
        let ty = dtype(r.i32()?)?;
        let mut ne = Vec::with_capacity(n_dims);
        for _ in 0..n_dims {
            ne.push(r.size(1 << 24)?);
        }
        let name = String::from_utf8(r.take(name_len)?.to_vec()).map_err(|_| bad("a name"))?;
        let elems = ne
            .iter()
            .try_fold(1usize, |a, d| a.checked_mul(*d))
            .ok_or_else(|| bad("a tensor's size"))?;
        if !elems.is_multiple_of(ty.block_size()) {
            return Err(bad("a tensor's size"));
        }
        // Checked: 2^62 f32s pass the product above and would overflow here.
        let len = (elems / ty.block_size())
            .checked_mul(ty.type_size())
            .ok_or_else(|| bad("a tensor's size"))?;
        let raw = r.take(len)?;
        // candle lists dimensions outermost first; the file innermost first. Size-1 dimensions
        // go (the convolutions' biases are stored as n × 1).
        let mut dims: Vec<usize> = ne.iter().rev().copied().collect();
        if dims.len() > 1 {
            dims.retain(|d| *d != 1);
        }
        let tensor =
            qtensor_from_ggml(ty, &Aligned::copy(raw), dims, device).map_err(candle_err)?;
        let tensor = if matches!(ty, GgmlDType::F32 | GgmlDType::F16) {
            tensor
        } else {
            let wide = tensor.dequantize(device).map_err(candle_err)?;
            QTensor::quantize(&wide, GgmlDType::F16).map_err(candle_err)?
        };
        tensors.push((candle_name(&name), tensor));
    }
    Ok(WhisperFile {
        hparams,
        filters,
        vocab,
        tensors,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    type Put<'a> = dyn FnMut(&mut Vec<u8>, &str, &[usize]) + 'a;

    /// A whisper.cpp file with random small weights (`n_state` wide, one layer each side): enough
    /// to run the whole pipeline. Also what the UI test's mock server serves.
    pub fn synthetic(n_state: usize) -> Vec<u8> {
        let s32 = n_state as i32;
        let hp = [51865, 1500, s32, 1, 1, 448, s32, 1, 1, 80, 0];
        let mut out = Vec::new();
        let i32s = |out: &mut Vec<u8>, v: i32| out.extend_from_slice(&v.to_le_bytes());
        i32s(&mut out, MAGIC as i32);
        for v in hp {
            i32s(&mut out, v);
        }
        i32s(&mut out, 80);
        i32s(&mut out, 201);
        for i in 0..80 * 201 {
            out.extend_from_slice(&(((i % 7) as f32) * 0.001).to_le_bytes());
        }
        i32s(&mut out, 3);
        for word in [b"hi".as_slice(), b" there", b"!"] {
            i32s(&mut out, word.len() as i32);
            out.extend_from_slice(word);
        }
        let mut seed = 1u32;
        let mut tensor = |out: &mut Vec<u8>, name: &str, ne: &[usize]| {
            i32s(out, ne.len() as i32);
            i32s(out, name.len() as i32);
            i32s(out, 0);
            for d in ne {
                i32s(out, *d as i32);
            }
            out.extend_from_slice(name.as_bytes());
            for _ in 0..ne.iter().product::<usize>() {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let v = ((seed >> 16) as f32 / 65536.0 - 0.5) * 0.2;
                out.extend_from_slice(&v.to_le_bytes());
            }
        };
        let s = n_state;
        tensor(&mut out, "encoder.positional_embedding", &[s, 1500]);
        tensor(&mut out, "encoder.conv1.weight", &[3, 80, s]);
        tensor(&mut out, "encoder.conv1.bias", &[1, s]);
        tensor(&mut out, "encoder.conv2.weight", &[3, s, s]);
        tensor(&mut out, "encoder.conv2.bias", &[1, s]);
        let block = |out: &mut Vec<u8>, t: &mut Put, p: &str, cross: bool| {
            let mut attn = |out: &mut Vec<u8>, a: &str| {
                for w in ["query", "key", "value", "out"] {
                    t(out, &format!("{p}.{a}.{w}.weight"), &[s, s]);
                    if w != "key" {
                        t(out, &format!("{p}.{a}.{w}.bias"), &[s]);
                    }
                }
                t(out, &format!("{p}.{a}_ln.weight"), &[s]);
                t(out, &format!("{p}.{a}_ln.bias"), &[s]);
            };
            attn(out, "attn");
            if cross {
                attn(out, "cross_attn");
            }
            t(out, &format!("{p}.mlp_ln.weight"), &[s]);
            t(out, &format!("{p}.mlp_ln.bias"), &[s]);
            t(out, &format!("{p}.mlp.0.weight"), &[s, 4 * s]);
            t(out, &format!("{p}.mlp.0.bias"), &[4 * s]);
            t(out, &format!("{p}.mlp.2.weight"), &[4 * s, s]);
            t(out, &format!("{p}.mlp.2.bias"), &[s]);
        };
        block(&mut out, &mut tensor, "encoder.blocks.0", false);
        tensor(&mut out, "encoder.ln_post.weight", &[s]);
        tensor(&mut out, "encoder.ln_post.bias", &[s]);
        tensor(&mut out, "decoder.positional_embedding", &[s, 448]);
        tensor(&mut out, "decoder.token_embedding.weight", &[s, 51865]);
        block(&mut out, &mut tensor, "decoder.blocks.0", true);
        tensor(&mut out, "decoder.ln.weight", &[s]);
        tensor(&mut out, "decoder.ln.bias", &[s]);
        out
    }

    #[test]
    fn names_follow_candle() {
        assert_eq!(
            candle_name("encoder.blocks.3.attn.query.weight"),
            "model.encoder.layers.3.self_attn.q_proj.weight"
        );
        assert_eq!(
            candle_name("decoder.blocks.0.cross_attn.out.bias"),
            "model.decoder.layers.0.encoder_attn.out_proj.bias"
        );
        assert_eq!(
            candle_name("decoder.blocks.0.cross_attn_ln.weight"),
            "model.decoder.layers.0.encoder_attn_layer_norm.weight"
        );
        assert_eq!(
            candle_name("encoder.blocks.0.mlp.2.bias"),
            "model.encoder.layers.0.fc2.bias"
        );
        assert_eq!(
            candle_name("decoder.ln.weight"),
            "model.decoder.layer_norm.weight"
        );
        assert_eq!(
            candle_name("encoder.ln_post.bias"),
            "model.encoder.layer_norm.bias"
        );
        assert_eq!(
            candle_name("decoder.token_embedding.weight"),
            "model.decoder.embed_tokens.weight"
        );
        assert_eq!(
            candle_name("encoder.positional_embedding"),
            "model.encoder.embed_positions.weight"
        );
    }

    #[test]
    fn reads_a_file() {
        let file = read(&synthetic(4), &Device::Cpu).map_err(|e| e.to_string());
        let file = file.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(file.hparams.n_vocab, 51865);
        assert_eq!(file.hparams.n_audio_state, 4);
        assert_eq!(file.filters.len(), 80 * 201);
        assert_eq!(
            file.vocab,
            vec![b"hi".to_vec(), b" there".to_vec(), b"!".to_vec()]
        );
        let bias = file
            .tensors
            .iter()
            .find(|(n, _)| n == "model.encoder.conv1.bias");
        assert_eq!(bias.map(|(_, t)| t.shape().dims().to_vec()), Some(vec![4]));
        let conv = file
            .tensors
            .iter()
            .find(|(n, _)| n == "model.encoder.conv1.weight");
        assert_eq!(
            conv.map(|(_, t)| t.shape().dims().to_vec()),
            Some(vec![4, 80, 3])
        );
    }

    #[test]
    fn refuses_what_isnt_one() {
        assert!(read(b"not a model", &Device::Cpu).is_err());
        let mut cut = synthetic(4);
        cut.truncate(cut.len() - 10);
        assert!(read(&cut, &Device::Cpu).is_err());
        assert!(read(&[], &Device::Cpu).is_err());
        // A tensor whose byte size overflows: refused, not a panic.
        let mut huge = synthetic(4);
        // Up to the first tensor: magic, 11 sizes, the filters, the vocabulary.
        huge.truncate(4 + 11 * 4 + 2 * 4 + 80 * 201 * 4 + 4 + (4 + 2) + (4 + 6) + (4 + 1));
        for v in [3i32, 1, 0, 1 << 24, 1 << 24, 1 << 14] {
            huge.extend_from_slice(&v.to_le_bytes());
        }
        huge.push(b'x');
        assert!(read(&huge, &Device::Cpu).is_err());
    }
}
