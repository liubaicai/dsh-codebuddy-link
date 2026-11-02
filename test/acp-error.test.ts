import test from 'node:test';
import assert from 'node:assert/strict';
import { acpLimitError } from '../src/acp-error.ts';

const reset = '2026-11-02 21:15:47 UTC+8';
const quota = (details: string) => ({ code: -32003, message: `Quota exceeded: ${details}`, data: { statusCode: 429, code: 6000, category: 'quota', details } });

test('official serialized ACP quota errors retain only classification and validated reset time', () => {
  const error = acpLimitError(JSON.stringify(quota(`429 您的使用量已超出频率限制，将在 ${reset} 重置。 SECRET_TOKEN https://private.invalid`)));
  assert.equal(error?.code, 'CODEBUDDY_QUOTA');
  assert.equal(error?.status, 429);
  assert.match(error!.message, /模型用量已达上限（HTTP 429）.*恢复时间：2026-11-02 21:15:47 UTC\+8.*切换其他模型/);
  assert.ok(error!.message.includes(reset));
  assert.doesNotMatch(error!.message, /SECRET_TOKEN|private\.invalid/);
});

test('quota and request-rate limits stay distinct, including plain legacy error text', () => {
  for (const value of [quota('SECRET_TOKEN'), {data:{category:'quota'}}]) assert.equal(acpLimitError(value)?.code, 'CODEBUDDY_QUOTA');
  for (const value of ['429 Too Many Requests SECRET_TOKEN', {code:-32003,data:{statusCode:429,category:'rate_limit'}}]) {
    const error = acpLimitError(value);
    assert.equal(error?.code, 'CODEBUDDY_RATE_LIMIT');
    assert.equal(error?.status, 429);
    assert.match(error!.message, /请求频率受限（HTTP 429）.*恢复时间：上游未提供.*切换其他模型.*稍后重试/);
    assert.doesNotMatch(error!.message, /SECRET_TOKEN/);
  }
  assert.doesNotMatch(acpLimitError({data:{category:'quota'}})!.message, /429/);
});

test('account credits, model usage and unknown quota causes are not conflated', () => {
  for (const details of ['账户积分不足', '账户余额已耗尽', 'insufficient credits', 'credit balance is too low']) {
    const error = acpLimitError({code:-32003,data:{category:'quota',statusCode:402,details}})!;
    assert.equal(error.code,'CODEBUDDY_CREDITS');
    assert.equal(error.status,402);
    assert.match(error.message,/账户积分或余额不足（HTTP 402）.*恢复时间：上游未提供.*检查账户/);
    assert.doesNotMatch(error.message,/模型用量已达上限|切换其他模型/);
  }
  for (const details of ['quota_token_limit', 'token_limit_exceeded', 'usage limit reached']) {
    assert.match(acpLimitError(quota(details))!.message,/模型用量已达上限/);
  }
  const unknown = acpLimitError(quota('SECRET_TOKEN'))!;
  assert.match(unknown.message,/上游未说明是模型用量限制还是账户余额不足/);
  assert.match(unknown.message,/恢复时间：上游未提供/);
  assert.notEqual(unknown.code,'QUOTA', 'DSH replaces QUOTA with generic copy and hides reset details');
});

test('HTTP status text is explicit and unrelated 429 numbers never authorize continuation', () => {
  for (const value of ['HTTP 429', 'request failed with status code: 429', 'HTTP/1.1 429 Too Many Requests']) assert.equal(acpLimitError(value)?.status,429);
  assert.equal(acpLimitError({code:-32603,message:'internal failure, request id 429'}),undefined);
  assert.equal(acpLimitError({data:{category:'quota'},message:'remaining quota 429'})?.status,undefined);
  assert.equal(acpLimitError({data:{statusCode:403,category:'quota'},message:'HTTP 429'})?.status,403);
})

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
