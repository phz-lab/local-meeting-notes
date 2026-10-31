import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import OpenCC from './vendor/opencc-t2cn.js';
env.allowLocalModels = false;
const simplify = OpenCC.Converter({ from: 't', to: 'cn' });
let transcriber, loadedModel;
self.onmessage = async ({ data }) => {
  try {
    const model = data.model === 'base' ? 'base' : 'small';
    if (!transcriber || loadedModel !== model) {
      self.postMessage({ type: 'progress', text: '正在下载并加载本地识别模型，首次使用可能需要几分钟…' });
      transcriber = await pipeline('automatic-speech-recognition', `onnx-community/whisper-${model}`, {
        dtype: 'q8',
        progress_callback: p => {
          if (p.status === 'progress' && p.progress) {
            self.postMessage({ type: 'progress', text: `正在下载模型：${p.file || ''} ${Math.round(p.progress)}%` });
          }
        },
      });
      loadedModel = model;
    }
    const samples = data.audio;
    const rate = 16000, block = 60 * rate, context = 5 * rate;
    const parts = [];
    for (let start = 0; start < samples.length; start += block) {
      const end = Math.min(start + block, samples.length);
      let inputStart = Math.max(0, start - context), inputEnd = Math.min(samples.length, end + context);
      self.postMessage({ type: 'progress', text: `正在本机转写第 ${Math.floor(start / block) + 1} / ${Math.ceil(samples.length / block)} 段…` });
      // Trim only digital silence at the edges; retain half a second of context.
      // Whisper can invent repeated speech for long, completely silent stretches.
      const silence = 0.00001, originalStart = inputStart, originalEnd = inputEnd;
      while (inputStart < inputEnd && Math.abs(samples[inputStart]) < silence) inputStart++;
      while (inputEnd > inputStart && Math.abs(samples[inputEnd - 1]) < silence) inputEnd--;
      if (inputStart === inputEnd) continue;
      inputStart = Math.max(originalStart, inputStart - rate / 2);
      inputEnd = Math.min(originalEnd, inputEnd + rate / 2);
      const result = await transcriber(samples.slice(inputStart, inputEnd), {
        language: 'chinese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5,
        return_timestamps: true, no_repeat_ngram_size: 5, repetition_penalty: 1.05,
      });
      let text;
      if (Array.isArray(result.chunks) && result.chunks.length) {
        if (samples.length > block && result.chunks.some(chunk => typeof chunk.timestamp?.[0] !== 'number')) {
          throw new Error('部分语音缺少时间信息，无法可靠拼接长录音；录音已保留。');
        }
        text = result.chunks.filter(chunk => {
          const [a, b] = chunk.timestamp || [];
          if (typeof a !== 'number') return start === 0;
          const chunkStart = inputStart / rate + a;
          const chunkEnd = inputStart / rate + (typeof b === 'number' ? b : a);
          return chunkEnd >= start / rate && chunkStart < end / rate;
        }).map(chunk => chunk.text).join('');
      } else {
        // A single-window response may contain only text.
        if (samples.length > block) throw new Error('模型未返回分段时间，无法可靠拼接长录音；录音已保留。');
        text = result.text || '';
      }
      text = simplify(text.trim());
      if (text && parts.length) {
        // Adjacent windows can both contain a boundary sentence. Remove only
        // an exact overlap; retaining uncertain words is safer than dropping them.
        const significant = char => /[\p{L}\p{N}]/u.test(char);
        const previous = Array.from(parts[parts.length - 1]).filter(significant).join('');
        const chars = Array.from(text), positions = [];
        chars.forEach((char, index) => { if (significant(char)) positions.push(index); });
        const next = positions.map(index => chars[index]).join('');
        for (let n = Math.min(previous.length, next.length); n >= 4; n--) {
          if (previous.endsWith(next.slice(0, n))) {
            text = chars.slice(positions[n - 1] + 1).join('').replace(/^[\s\p{P}]+/u, '');
            break;
          }
        }
      }
      if (text) parts.push(text);
      self.postMessage({ type: 'partial', text: parts.join('\n') });
    }
    self.postMessage({ type: 'done', text: parts.join('\n') });
  } catch (e) {
    self.postMessage({ type: 'error', text: e?.message || String(e) });
  }
};
