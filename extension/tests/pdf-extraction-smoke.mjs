import assert from 'node:assert/strict';
import fs from 'node:fs';

// PDF.js only uses these rendering dependencies in Node; suppress their known
// non-fatal warnings because this smoke test verifies text extraction, not canvas rendering.
const originalWarn = console.warn;
const originalLog = console.log;
const suppressKnownNodeWarning = (original) => (...args) => {
  const message = args.map(String).join(' ');
  if (message.includes('@napi-rs/canvas') || message.includes('DOMMatrix') ||
      message.includes('Path2D') || message.includes('Unable to load font data')) return;
  original(...args);
};
console.warn = suppressKnownNodeWarning(originalWarn);
console.log = suppressKnownNodeWarning(originalLog);
const pdfjsLib = await import('../lib/pdf.mjs');

const file = new URL('./fixtures/anonymous-resume-demo.pdf', import.meta.url);
const pdf = await pdfjsLib.getDocument({
  data: new Uint8Array(fs.readFileSync(file)),
  disableWorker: true,
  isEvalSupported: false
}).promise;

let text = '';
for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
  const page = await pdf.getPage(pageNo);
  const content = await page.getTextContent();
  text += content.items.map((item) => item.str).join(' ') + '\n';
}
assert.equal(pdf.numPages, 1);
assert(text.includes('13912345678'));
assert(text.includes('demo@example.com'));
assert(text.includes('Work Experience'));
console.warn = originalWarn;
console.log = originalLog;
console.log('PASS: local PDF text extraction (4 assertions)');
