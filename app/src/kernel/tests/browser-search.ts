import assert from 'node:assert/strict';

import { parseDuckResults, decodeDuckHref } from '../providers/browser';

const FIXTURE = `
<div class="result__body">
  <h2><a rel="nofollow" class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Ffirst">First <b>Result</b></a></h2>
  <a class="result__snippet" href="/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst">Snipped text one.</a>
</div>
<div class="result__body">
  <h2><a rel="nofollow" class="result__a" href="https://example.org/direct">Direct Link</a></h2>
  <div class="result__snippet">Plain div snippet.</div>
</div>
<div class="result__body">
  <h2>No link here</h2>
</div>`;

async function main(): Promise<void> {
  // A. Parses wrapped and direct links, strips markup, respects limit.
  const parsed = parseDuckResults(FIXTURE, 10);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'First Result');
  assert.equal(parsed[0].url, 'https://example.com/first');
  assert.equal(parsed[0].snippet, 'Snipped text one.');
  assert.equal(parsed[1].url, 'https://example.org/direct');
  assert.equal(parseDuckResults(FIXTURE, 1).length, 1);
  console.log('PASS (A): DDG fixture parses links, snippets, and limits');

  // B. Href decoding handles redirect, direct, and garbage.
  assert.equal(decodeDuckHref('/l/?kh=-1&uddg=https%3A%2F%2Fx.test%2Fy'), 'https://x.test/y');
  assert.equal(decodeDuckHref('https://plain.test/'), 'https://plain.test/');
  assert.equal(decodeDuckHref(''), '');
  console.log('PASS (B): redirect decoding is total (never throws)');

  console.log('PASS: browser search parser tests complete');
}

main().catch(error => {
  console.error('FAIL: browser search parser test');
  console.error(error);
  process.exitCode = 1;
});
