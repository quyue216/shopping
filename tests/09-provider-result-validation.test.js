import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderFinalAmount } from '../src/utils/providerResult.js';

test('相同金额正常通过，包括超过 JS 安全整数的金额', () => {
  assert.doesNotThrow(() => validateProviderFinalAmount({ amount: '300' }, '300'));
  assert.doesNotThrow(() => validateProviderFinalAmount({ amount: '9007199254740993' }, '9007199254740993'));
});

test('不同金额拒绝，包括超过 JS 安全整数的值', () => {
  assert.throws(() => validateProviderFinalAmount({ amount: '301' }, '300'), /金额不一致/);
  assert.throws(() => validateProviderFinalAmount({ amount: '9007199254740992' }, '9007199254740993'), /金额不一致/);
});

test('缺失金额、数字金额或非规范字符串均拒绝', () => {
  for (const bad of [undefined, null, 300, -3, '3.00', '03', '-3', ' 300', '', '3e2']) {
    assert.throws(() => validateProviderFinalAmount({ amount: bad }, '300'), /金额缺失或格式错误/);
  }
  assert.throws(() => validateProviderFinalAmount(null, '300'), /金额缺失或格式错误/);
});
