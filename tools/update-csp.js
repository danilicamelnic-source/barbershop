// Recomputes the sha256 hashes in the page's <meta> Content-Security-Policy after you edit the inline
// <script> or <style> in public/index.html. (The server computes its own header automatically; this keeps
// the meta tag correct for opening the file directly.)  Usage: npm run csp
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const file = path.resolve(__dirname, '..', process.argv[2] || 'public/index.html');
let html = fs.readFileSync(file, 'utf8');
const h = (s) => "'sha256-" + crypto.createHash('sha256').update(s, 'utf8').digest('base64') + "'";
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => h(m[1]));
const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => h(m[1]));
html = html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?)script-src [^;"]*/, `$1script-src ${js.join(' ')}`)
           .replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*?)style-src [^;"]*/, `$1style-src ${css.join(' ')} https://fonts.googleapis.com`);
fs.writeFileSync(file, html);
console.log('Updated CSP in', path.relative(process.cwd(), file), '\n script-src', js.join(' '), '\n style-src', css.join(' '));
