// Describe image (src/ops/describe.js): when it is offered, what it sends, how replies are read.
import assert from 'node:assert/strict';
import { canDescribe, destination, buildRequest, parseReply } from '../src/ops/describe.js';

const nak = (caps) => ({ capabilities: { hosted: true, ai: true, experimental_aiVision: true, ...caps }, ai: { chat: { completions: { create() {} } } } });
assert.equal(canDescribe(nak({})), true);
assert.equal(canDescribe(nak({ experimental_aiVision: false })), false, 'hidden without vision');
assert.equal(canDescribe(nak({ hosted: false })), false, 'hidden standalone');
assert.equal(canDescribe(undefined), false);
assert.match(destination(nak({ aiLocal: false, aiModelLabel: 'Claude', aiProvider: 'Anthropic' })), /Claude \(Anthropic\), outside this device/);
assert.match(destination(nak({ aiLocal: true, aiModelLabel: 'Qwen VL' })), /Qwen VL, on this computer/);

const req = buildRequest('data:image/jpeg;base64,AAAA');
assert.equal(req.agent, true, 'vision needs an agent request');
assert.equal(req.messages[0].content[1].type, 'image_url');
assert.equal(req.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
assert.throws(() => buildRequest('https://example.com/a.jpg'), /data URL/, 'never a remote URL');

assert.deepEqual(parseReply('A beach at sunset with two people.\nKeywords: beach, sunset, people, sea.'), { description: 'A beach at sunset with two people.', keywords: ['beach', 'sunset', 'people', 'sea'] });
assert.deepEqual(parseReply('Just a description.'), { description: 'Just a description.', keywords: [] });
console.log('Slate describe image: PASS');
