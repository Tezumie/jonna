# Provider and agent logos

The AI models page shows each provider and agent with its logo from this folder, named after its
brand key. Without a file, a letter badge in the brand's color is shown instead (D167).

| File | Used for |
|---|---|
| `anthropic.svg` | Anthropic |
| `claudecode.svg` | Claude Code |
| `openai.svg` | OpenAI |
| `codex.svg` | Codex |
| `gemini.svg` | Google Gemini |
| `geminicli.svg` | Gemini CLI |
| `xai.svg` | xAI |
| `openrouter.svg` | OpenRouter |
| `groq.svg` | Groq |
| `lmstudio.svg` | LM Studio |
| `llamacpp.svg` | llama.cpp (none yet: letter badge) |
| `ollama.svg` | Ollama |
| `github.svg` | GitHub Copilot |
| `mistral.svg` | Mistral AI (D212) |
| `deepseek.svg` | DeepSeek (D212) |
| `together.svg` | Together AI (D212) |
| `fireworks.svg` | Fireworks AI (D212) |
| `cerebras.svg` | Cerebras (D212) |
| `huggingface.svg` | Hugging Face (D212) |
| `nvidia.svg` | NVIDIA NIM (D212) |
| `kimi.svg` | Kimi (Moonshot AI) (D212) |
| `qwen.svg` | Qwen (Alibaba Cloud) (D212) |
| `zai.svg` | Z.ai (D212) |
| `azure.svg` | Azure OpenAI (D212) |
| `bedrock.svg` | Amazon Bedrock (D212) |
| `vllm.svg` | vLLM (D212) |
| `sambanova.svg` | SambaNova (D227) |
| `novita.svg` | Novita AI (D227) |
| `deepinfra.svg` | DeepInfra (D227) |
| `hyperbolic.svg` | Hyperbolic (D227) |
| `nebius.svg` | Nebius AI Studio (D227) |
| `siliconflow.svg` | SiliconFlow (D227) |
| `volcengine.svg` | Volcengine Ark (D227) |
| `stepfun.svg` | StepFun (D227) |
| `modelscope.svg` | ModelScope (D227) |
| `friendli.svg` | Friendli (D227) |
| `featherless.svg` | Featherless (D227) |
| `chutes.svg` | Chutes (D227) |
| `venice.svg` | Venice AI (D227) |
| `kluster.svg` | kluster.ai (D227) |
| `inference.svg` | Inference.net (D227) |
| `ppio.svg` | PPIO (D227) |
| `vercel.svg` | Vercel AI Gateway (D227) |
| `aihubmix.svg` | AIHubMix (D227) |
| `cometapi.svg` | CometAPI (D227) |
| `xinference.svg` | Xinference (D227) |

**Source:** `@lobehub/icons-static-svg` 1.95.1 (MIT), files copied unaltered:
`anthropic`, `openai`, `gemini-color` → `gemini`, `xai`, `openrouter`, `groq`, `lmstudio`,
`ollama`, `githubcopilot` → `github`, `claudecode-color` → `claudecode`, `codex-color` → `codex`,
`geminicli-color` → `geminicli`; and for D212 the one-color (non `-color`) files `mistral`,
`deepseek`, `together`, `fireworks`, `cerebras`, `huggingface`, `nvidia`, `kimi`, `qwen`, `zai`,
`azure`, `bedrock`, `vllm` — drawn as a mask in a semantic color on the brand's token
(`--brand-<key>` in tokens.css), so no colors live in the files. For D227's presets, from the same package: `sambanova-color` → `sambanova`, `novita-color` → `novita`, `deepinfra-color` → `deepinfra`, `hyperbolic-color` → `hyperbolic`, `nebius`, `siliconcloud-color` → `siliconflow`, `volcengine-color` → `volcengine`, `stepfun-color` → `stepfun`, `modelscope-color` → `modelscope`, `friendli`, `featherless-color` → `featherless`, `chutes`, `venice-color` → `venice`, `kluster-color` → `kluster`, `inference`, `ppio-color` → `ppio`, `vercel`, `aihubmix-color` → `aihubmix`, `cometapi-color` → `cometapi`, `xinference-color` → `xinference`. Jan has no logo there (letter badge). The package's license:

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The logos themselves are trademarks of their owners, used to
name the services the IDE connects to (as in "works with" listings); follow each company's
brand guidelines if you change how they're shown, and replace a file with the company's own
brand-kit version whenever you like.

`scripts/gen.mjs` turns these into `src/extensions/agent/brandLogos.ts` (git-ignored) on
`npm run dev` / `build` / `check`; files with scripts or event handlers are skipped.
