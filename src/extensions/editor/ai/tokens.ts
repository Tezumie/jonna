// Token counts for the suggestion prompt's budget (D224). A real tokenizer per model would mean
// shipping its vocabulary (cl100k alone is ~1.7 MB, Qwen's or Llama's tokenizer.json 7–9 MB, and
// the user's model could be any of dozens): too heavy for a budget that only has to be about
// right. Instead an estimate that follows how byte-pair tokenizers split text — words (camelCase
// and snake_case parts), digit groups, punctuation runs, indentation and newlines — with a few
// parameters per model family. Calibrated against cl100k / o200k (gpt-tokenizer, outside the
// repo) on this repo's TypeScript, Rust, JavaScript and Python: within 5 % on code, 12 % low on
// JSON and Markdown; the SentencePiece family (32k vocabularies) is
// set from published averages, not measured. DOM-free and tested.

/** How a model family's tokenizer splits text, as far as the estimate needs it. */
export interface TokenizerProfile {
  /** A name for the state tree ("large-bpe", "large-bpe-digits", "sentencepiece", "default"). */
  name: string;
  /** Letters a word part takes per token beyond its first (common parts are one token). */
  wordChars: number;
  /** Digits per token (cl100k / Llama 3 group 3; Qwen, DeepSeek, StarCoder, Llama 2 split each). */
  digitGroup: number;
  /** Spaces per token in indentation (large vocabularies have long runs; SentencePiece 32k few). */
  spaceRun: number;
  /** Punctuation characters per token. */
  punctChars: number;
}

const LARGE_BPE: TokenizerProfile = {
  name: "large-bpe",
  wordChars: 10,
  digitGroup: 3,
  spaceRun: 16,
  punctChars: 3,
};
const LARGE_BPE_DIGITS: TokenizerProfile = {
  ...LARGE_BPE,
  name: "large-bpe-digits",
  digitGroup: 1,
};
const SENTENCEPIECE: TokenizerProfile = {
  name: "sentencepiece",
  wordChars: 5,
  digitGroup: 1,
  spaceRun: 4,
  punctChars: 1.5,
};
const DEFAULT: TokenizerProfile = { ...LARGE_BPE, name: "default", wordChars: 8 };

/** The tokenizer profile of a model by its name ("provider/model" or the bare model). */
export function tokenizerProfile(model: string | null | undefined): TokenizerProfile {
  const m = (model ?? "").toLowerCase();
  // 32k SentencePiece vocabularies: Llama 2 and Code Llama, Mistral 7B / Mixtral, old Codestral.
  if (/code-?llama|llama-?2|mistral(?!-?(nemo|large|small-?3))|mixtral|codestral-?22b/.test(m))
    return SENTENCEPIECE;
  // Large BPE vocabularies that split numbers into single digits.
  if (/qwen|deepseek|starcoder|granite|codegemma|gemma|stable-?code|phi/.test(m))
    return LARGE_BPE_DIGITS;
  // cl100k / o200k (OpenAI), Llama 3, Codestral 25.x (Tekken), Claude: large vocabularies.
  if (/gpt|o[1-9]|llama-?3|llama3|codestral|claude|tekken|nemo/.test(m)) return LARGE_BPE;
  return DEFAULT;
}

// Pre-tokenization close to cl100k's: an optional non-letter before a run of letters, digits,
// punctuation runs, newlines (with the spaces before them), other whitespace.
const PIECES = /[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}+|[^\s\p{L}\p{N}]+|\s*[\r\n]+|[ \t]+|\s/gu;
/** Parts of an identifier: "parseHTTPRequest" → parse, HTTP, Request. */
const WORD_PARTS = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{L}+/gu;

/** About how many tokens `text` is for `profile`'s tokenizer. */
export function estimateTokens(text: string, profile: TokenizerProfile = DEFAULT): number {
  let n = 0;
  for (const piece of text.match(PIECES) ?? []) {
    const c = piece.charCodeAt(0);
    if (/\p{L}/u.test(piece.at(-1) ?? "")) {
      // A word, maybe with one leading space or symbol (" foo", ".log", "_id": one token).
      const letters = /\p{L}/u.test(piece[0] ?? "") ? piece : piece.slice(1);
      for (const part of letters.match(WORD_PARTS) ?? [])
        n += 1 + Math.floor(Math.max(0, part.length - 1) / profile.wordChars);
    } else if (c >= 48 && c <= 57) n += Math.ceil(piece.length / profile.digitGroup);
    else if (/[\r\n]/.test(piece)) n += 1;
    else if (/^[ \t]+$/.test(piece)) {
      // Spaces before a word: the last one joins the word.
      const run = piece.length - 1;
      if (run > 0) n += Math.ceil(run / profile.spaceRun);
    } else if (/^\s$/.test(piece)) n += 1;
    else n += Math.ceil(piece.length / profile.punctChars);
  }
  return n;
}

/** Characters a token of `sample` takes for `profile` (bounded: a sample can be odd). */
export function charsPerToken(sample: string, profile: TokenizerProfile = DEFAULT): number {
  if (sample.length < 200) return 4;
  const tokens = estimateTokens(sample, profile);
  return Math.min(6, Math.max(1.5, sample.length / Math.max(1, tokens)));
}
