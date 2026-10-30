import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import OpenCC from './vendor/opencc-t2cn.js';
env.allowLocalModels=false;
const simplify=OpenCC.Converter({from:'t',to:'cn'});
let transcriber;
self.onmessage=async ({data})=>{try{
 if(!transcriber){self.postMessage({type:'progress',text:'正在下载并加载中文识别模型，首次可能需要几分钟…'});transcriber=await pipeline('automatic-speech-recognition','onnx-community/whisper-base',{dtype:'q8',progress_callback:p=>{if(p.status==='progress'&&p.progress)self.postMessage({type:'progress',text:`正在下载模型：${p.file||''} ${Math.round(p.progress)}%`})}})}
 const samples=data.audio; const step=30*16000;let parts=[];
 for(let i=0;i<samples.length;i+=step){self.postMessage({type:'progress',text:`正在本机转写 ${Math.min(Math.floor(i/step)+1,Math.ceil(samples.length/step))} / ${Math.ceil(samples.length/step)} 段…`});const r=await transcriber(samples.slice(i,i+step),{language:'chinese',task:'transcribe',no_repeat_ngram_size:4,repetition_penalty:1.1,max_new_tokens:180});parts.push(simplify(r.text.trim()));self.postMessage({type:'partial',text:parts.join('\n')});}
 self.postMessage({type:'done',text:parts.join('\n')});
 }catch(e){self.postMessage({type:'error',text:e?.message||String(e)})}};
