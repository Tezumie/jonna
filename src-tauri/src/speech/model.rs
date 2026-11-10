//! Whisper's network (D384), adapted from candle-transformers' `whisper/quantized_model.rs`
//! (MIT/Apache-2.0) with one change: the decoder keeps its own keys and values as it goes, so
//! each new token costs one token's work instead of the whole text again (candle's recomputes
//! every earlier token at each step).

use candle_core::{Module, Result, Tensor, D};
use candle_nn::{Conv1d, Conv1dConfig, LayerNorm};
use candle_transformers::quantized_nn::{layer_norm, linear, linear_no_bias, Embedding, Linear};
use candle_transformers::quantized_var_builder::VarBuilder;

use super::ggml::Hparams;

struct Attention {
    q: Linear,
    k: Linear,
    v: Linear,
    out: Linear,
    n_head: usize,
    /// Cross-attention: the audio's keys and values (computed once per segment). Self-attention:
    /// every earlier token's.
    cache: Option<(Tensor, Tensor)>,
}

impl Attention {
    fn load(n: usize, n_head: usize, vb: VarBuilder) -> Result<Self> {
        Ok(Self {
            q: linear(n, n, vb.pp("q_proj"))?,
            k: linear_no_bias(n, n, vb.pp("k_proj"))?,
            v: linear(n, n, vb.pp("v_proj"))?,
            out: linear(n, n, vb.pp("out_proj"))?,
            n_head,
            cache: None,
        })
    }

    fn heads(&self, x: &Tensor) -> Result<Tensor> {
        let (b, t, s) = x.dims3()?;
        x.reshape((b, t, self.n_head, s / self.n_head))?
            .transpose(1, 2)
    }

    /// `audio`: cross-attention over it. Otherwise self-attention; `causal` (the decoder) keeps
    /// what it has seen and masks what comes after each new token.
    fn forward(&mut self, x: &Tensor, audio: Option<&Tensor>, causal: bool) -> Result<Tensor> {
        let q = self.q.forward(x)?;
        let (k, v) = match audio {
            Some(src) => match &self.cache {
                Some((k, v)) => (k.clone(), v.clone()),
                None => {
                    let kv = (self.k.forward(src)?, self.v.forward(src)?);
                    self.cache = Some(kv.clone());
                    kv
                }
            },
            None => {
                let (k, v) = (self.k.forward(x)?, self.v.forward(x)?);
                if causal {
                    let kv = match &self.cache {
                        Some((pk, pv)) => (Tensor::cat(&[pk, &k], 1)?, Tensor::cat(&[pv, &v], 1)?),
                        None => (k, v),
                    };
                    self.cache = Some(kv.clone());
                    kv
                } else {
                    (k, v)
                }
            }
        };
        let (_, t, s) = q.dims3()?;
        let scale = ((s / self.n_head) as f64).powf(-0.25);
        let q = (self.heads(&q)? * scale)?;
        let k = (self.heads(&k)?.transpose(2, 3)? * scale)?;
        let v = self.heads(&v)?.contiguous()?;
        let mut qk = q.matmul(&k)?;
        if audio.is_none() && causal && t > 1 {
            // Earlier tokens are all visible; among the new ones, only those before.
            let total = qk.dim(D::Minus1)?;
            let past = total - t;
            let mask: Vec<f32> = (0..t)
                .flat_map(|i| {
                    (0..total).map(move |j| if j > past + i { f32::NEG_INFINITY } else { 0.0 })
                })
                .collect();
            qk = qk.broadcast_add(&Tensor::from_vec(mask, (t, total), qk.device())?)?;
        }
        let w = candle_nn::ops::softmax_last_dim(&qk)?;
        let wv = w.matmul(&v)?.transpose(1, 2)?.flatten_from(2)?;
        self.out.forward(&wv)
    }
}

struct Block {
    attn: Attention,
    attn_ln: LayerNorm,
    cross: Option<(Attention, LayerNorm)>,
    fc1: Linear,
    fc2: Linear,
    mlp_ln: LayerNorm,
}

impl Block {
    fn load(n: usize, n_head: usize, cross: bool, vb: VarBuilder) -> Result<Self> {
        let cross = if cross {
            Some((
                Attention::load(n, n_head, vb.pp("encoder_attn"))?,
                layer_norm(n, 1e-5, vb.pp("encoder_attn_layer_norm"))?,
            ))
        } else {
            None
        };
        Ok(Self {
            attn: Attention::load(n, n_head, vb.pp("self_attn"))?,
            attn_ln: layer_norm(n, 1e-5, vb.pp("self_attn_layer_norm"))?,
            cross,
            fc1: linear(n, 4 * n, vb.pp("fc1"))?,
            fc2: linear(4 * n, n, vb.pp("fc2"))?,
            mlp_ln: layer_norm(n, 1e-5, vb.pp("final_layer_norm"))?,
        })
    }

    fn forward(&mut self, x: &Tensor, audio: Option<&Tensor>, causal: bool) -> Result<Tensor> {
        let x = (x + self.attn.forward(&self.attn_ln.forward(x)?, None, causal)?)?;
        let x = match (&mut self.cross, audio) {
            (Some((a, ln)), Some(audio)) => {
                (&x + a.forward(&ln.forward(&x)?, Some(audio), false)?)?
            }
            _ => x,
        };
        let h = self.fc1.forward(&self.mlp_ln.forward(&x)?)?.gelu()?;
        x + self.fc2.forward(&h)?
    }

    fn forget(&mut self) {
        self.attn.cache = None;
        if let Some((a, _)) = &mut self.cross {
            a.cache = None;
        }
    }
}

fn conv(i: usize, o: usize, stride: usize, vb: VarBuilder) -> Result<Conv1d> {
    let w = vb.get((o, i, 3), "weight")?.dequantize(vb.device())?;
    let b = vb.get(o, "bias")?.dequantize(vb.device())?;
    let config = Conv1dConfig {
        padding: 1,
        stride,
        dilation: 1,
        groups: 1,
        cudnn_fwd_algo: None,
    };
    Ok(Conv1d::new(w, Some(b), config))
}

pub struct Whisper {
    conv1: Conv1d,
    conv2: Conv1d,
    audio_pos: Tensor,
    encoder: Vec<Block>,
    encoder_ln: LayerNorm,
    tokens: Embedding,
    text_pos: Tensor,
    decoder: Vec<Block>,
    decoder_ln: LayerNorm,
    /// How many tokens the decoder has seen since `reset`.
    seen: usize,
    pub text_ctx: usize,
}

impl Whisper {
    pub fn load(vb: &VarBuilder, hp: &Hparams) -> Result<Self> {
        let (n, heads) = (hp.n_audio_state, hp.n_audio_head);
        let enc = vb.pp("model.encoder");
        let dec = vb.pp("model.decoder");
        Ok(Self {
            conv1: conv(hp.n_mels, n, 1, enc.pp("conv1"))?,
            conv2: conv(n, n, 2, enc.pp("conv2"))?,
            audio_pos: enc
                .get((hp.n_audio_ctx, n), "embed_positions.weight")?
                .dequantize(vb.device())?,
            encoder: (0..hp.n_audio_layer)
                .map(|i| Block::load(n, heads, false, enc.pp(format!("layers.{i}"))))
                .collect::<Result<_>>()?,
            encoder_ln: layer_norm(n, 1e-5, enc.pp("layer_norm"))?,
            tokens: Embedding::new(hp.n_vocab, n, dec.pp("embed_tokens"))?,
            text_pos: dec
                .get((hp.n_text_ctx, n), "embed_positions.weight")?
                .dequantize(vb.device())?,
            decoder: (0..hp.n_text_layer)
                .map(|i| Block::load(n, heads, true, dec.pp(format!("layers.{i}"))))
                .collect::<Result<_>>()?,
            decoder_ln: layer_norm(n, 1e-5, dec.pp("layer_norm"))?,
            seen: 0,
            text_ctx: hp.n_text_ctx,
        })
    }

    /// A (1, n_mels, frames) log-mel segment → the audio features the decoder attends to.
    pub fn encode(&mut self, mel: &Tensor) -> Result<Tensor> {
        let x = self.conv1.forward(mel)?.gelu()?;
        let x = self.conv2.forward(&x)?.gelu()?.transpose(1, 2)?;
        let frames = x.dim(1)?.min(self.audio_pos.dim(0)?);
        let x = x.narrow(1, 0, frames)?;
        let mut x = x.broadcast_add(&self.audio_pos.narrow(0, 0, frames)?)?;
        for block in self.encoder.iter_mut() {
            x = block.forward(&x, None, false)?;
        }
        self.encoder_ln.forward(&x)
    }

    /// Starts a new text (and a new segment's audio): the decoder forgets what it kept.
    pub fn reset(&mut self) {
        self.seen = 0;
        for block in self.decoder.iter_mut() {
            block.forget();
        }
    }

    pub fn seen(&self) -> usize {
        self.seen
    }

    /// Feeds `tokens` after those already seen; the logits (vocabulary scores) of each one,
    /// shaped (tokens, vocabulary).
    pub fn decode(&mut self, tokens: &[u32], audio: &Tensor) -> Result<Tensor> {
        let x = Tensor::new(tokens, audio.device())?.unsqueeze(0)?;
        let pos = self.text_pos.narrow(0, self.seen, tokens.len())?;
        let mut x = self.tokens.forward(&x)?.broadcast_add(&pos)?;
        for block in self.decoder.iter_mut() {
            x = block.forward(&x, Some(audio), true)?;
        }
        self.seen += tokens.len();
        let x = self.decoder_ln.forward(&x)?.squeeze(0)?;
        // (vocabulary × state) · (state × tokens): the large matrix isn't transposed.
        self.tokens
            .embeddings()
            .matmul(&x.t()?.contiguous()?)?
            .t()?
            .contiguous()
    }
}
