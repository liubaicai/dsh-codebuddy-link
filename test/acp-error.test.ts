import test from 'node:test';
import assert from 'node:assert/strict';
import { acpLimitError } from '../src/acp-error.ts';

const reset = '2026-11-02 21:15:47 UTC+8';
const quota = (details: string) => ({ code: -32003, message: `Quota exceeded: ${details}`, data: { statusCode: 429, code: 6000, category: 'quota', details } });

test('official serialized ACP quota errors retain only classification and validated reset time', () => {
  const error = acpLimitError(JSON.stringify(quota(`429 您的使用量已超出频率限制，将在 ${reset} 重置。 SECRET_TOKEN https://private.invalid`)));
  assert.equal(error?.code, 'QUOTA');
  assert.equal(error?.status, 429);
  assert.match(error!.message, /配额已用尽（429）.*切换其他模型/);
  assert.ok(error!.message.includes(reset));
  assert.doesNotMatch(error!.message, /SECRET_TOKEN|private\.invalid/);
});

test('quota and request-rate limits stay distinct, including plain legacy error text', () => {
  for (const value of [quota('SECRET_TOKEN'), {data:{category:'quota'}}]) assert.equal(acpLimitError(value)?.code, 'QUOTA');
  for (const value of ['429 Too Many Requests SECRET_TOKEN', {code:-32003,data:{statusCode:429,category:'rate_limit'}}]) {
    const error = acpLimitError(value);
    assert.equal(error?.code, 'CODEBUDDY_RATE_LIMIT');
    assert.equal(error?.status, 429);
    assert.match(error!.message, /限流（429）.*切换其他模型.*稍后重试/);
    assert.doesNotMatch(error!.message, /SECRET_TOKEN/);
  }
  assert.doesNotMatch(acpLimitError({data:{category:'quota'}})!.message, /429/);
});

test('unlabelled, invalid or timezone-less dates are not advertised as reset times', () => {
  for (const detail of [reset, '将在 2026-02-30 21:15:47 UTC+8 重置', '将在 2026-11-02 25:15:47 UTC+8 重置', '将在 2026-11-02 21:15:47 重置', '将在 2026-11-02 21:15:47 UTC+99 重置', '将在 2026-11-02 21:15:47 UTC+14:59 重置']) {
    assert.doesNotMatch(acpLimitError(quota(detail))!.message, /2026-/);
  }
  assert.match(acpLimitError(quota('resets at 2026-11-02T13:15:47Z'))!.message, /2026-11-02 13:15:47 Z/);
});

test('unknown errors, arbitrary nested content and oversized strings are not classified', () => {
  for (const value of [undefined, null, [], 'SECRET_TOKEN', {message:'transport failed',data:{details:'private diagnostic'}}, {content:{text:'429 quota'}}, JSON.stringify({code:-32603,data:{url:'https://example.invalid/429'}}), 'x'.repeat(16*1024+1)+'429 quota']) {
    assert.equal(acpLimitError(value), undefined);
  }
});
