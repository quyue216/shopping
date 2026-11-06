/** 验证支付平台终态响应金额，防止错误确认支付或取消订单。金额单位：分。 */
export function validateProviderFinalAmount(result, expectedAmount) {
  const amount = result?.amount;
  // 平台 API 约定返回十进制整数字符串，不允许先转 Number（会损失 BIGINT 精度）。
  if (typeof amount !== 'string' || !/^(0|[1-9]\d*)$/.test(amount)) {
    throw new Error('支付平台返回金额缺失或格式错误');
  }
  if (BigInt(amount) !== BigInt(expectedAmount)) {
    throw new Error('支付平台返回金额与本地支付金额不一致');
  }
}
