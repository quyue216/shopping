/**
 * 金额约定（全项目统一）：
 * - 数据库：BIGINT 存整数"分"（pg 读出为字符串，不会丢精度）
 * - 内部计算：一律 BigInt，禁止 Number() 经手金额（Number 无法精确表示 2^53 以上的 BIGINT）
 * - API：金额字段（price / totalAmount / unitPrice / amount）对外一律为十进制整数字符串；
 *        请求侧兼容安全整数 number 或十进制字符串，统一由 parseCents 校验解析
 */

import { HttpError } from '../httpError.js';

/** PostgreSQL BIGINT 最大值：所有金额字段（单位：分）不得超过它 */
export const MAX_CENTS = 9223372036854775807n;

/**
 * 解析 API 传入的金额（单位：分）为 BigInt。
 * 接受安全整数 number 或十进制字符串（大金额必须用字符串，避免 JSON number 精度丢失）；
 * 负数、小数、超上限等一律抛 HttpError(400)。
 */
export function parseCents(value, field = '金额') {
  let cents;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new HttpError(400, `${field}超出安全整数范围，请用十进制字符串传参（单位：分）`);
    }
    cents = BigInt(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    cents = BigInt(value.trim());
  } else {
    throw new HttpError(400, `${field}必须为整数（单位：分），可传数字或十进制字符串`);
  }
  if (cents < 0n) {
    throw new HttpError(400, `${field}不能为负数（单位：分）`);
  }
  if (cents > MAX_CENTS) {
    throw new HttpError(400, `${field}超出 BIGINT 上限`);
  }
  return cents;
}
