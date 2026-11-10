// `node tone-wav.mjs <file> [seconds]`: writes a 16 kHz mono 16-bit WAV of a soft tone (dictation's
// UI test, D384: something to transcribe that isn't silence).
import { writeFileSync } from "node:fs";

const [file = "tone.wav", seconds = "2"] = process.argv.slice(2);
const rate = 16000;
const count = Math.round(Number(seconds) * rate);
const data = Buffer.alloc(count * 2);
for (let i = 0; i < count; i++)
  data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 0.3 * 32767), i * 2);
const header = Buffer.alloc(44);
header.write("RIFF", 0, "ascii");
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVEfmt ", 8, "ascii");
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36, "ascii");
header.writeUInt32LE(data.length, 40);
writeFileSync(file, Buffer.concat([header, data]));
console.log(`wrote ${file}`);
