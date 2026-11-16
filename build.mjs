// Joins src/*.js into one self-contained index.html (no dependencies): node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const js = ['math', 'world', 'shaders', 'audio', 'main'].map((n) => read(`src/${n}.js`)).join('\n');
const html = read('template.html').replace('/*JS*/', () => js);
const out = (name, h) => { writeFileSync(new URL(name, dir), h); console.log(`${name}: ${(h.length / 1024).toFixed(1)} KB`); };
out('index.html', html);
