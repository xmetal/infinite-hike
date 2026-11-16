// Joins src/*.js into self-contained index.html and index-fast.html (no dependencies): node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const js = ['math', 'world', 'shaders', 'audio', 'main'].map((n) => read(`src/${n}.js`)).join('\n');
const html = read('template.html').replace('/*JS*/', () => js);
const out = (name, h) => { writeFileSync(new URL(name, dir), h); console.log(`${name}: ${(h.length / 1024).toFixed(1)} KB`); };
out('index.html', html);
// index-fast.html was the trial of the culling that is now the default; it is kept as an identical copy for now
out('index-fast.html', html);
