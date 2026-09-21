process.env.TRANSFORMERS_CACHE = '/app/data/models';
import { pipeline } from '@xenova/transformers';
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const out = await extractor(['a difficult percentage question', 'geometry shapes'], { pooling: 'mean', normalize: true });
console.log('dims:', out.dims, 'took(ms):', Date.now() - t0);
console.log('first vec length:', out.tolist()[0].length);
