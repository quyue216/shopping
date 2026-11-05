/** API 调用辅助：JWT 直接签名（绕过注册登录，聚焦订单链路） */

import jwt from 'jsonwebtoken';
import { API_URL } from './setup.js';

export function signToken(userId, username = 'tester') {
  return jwt.sign({ sub: String(userId), username }, process.env.JWT_SECRET);
}

/** POST /orders，返回 { status, body }，不抛错（便于断言 4xx/5xx） */
export async function postOrder({ token, idempotencyKey, items }) {
  const res = await fetch(`${API_URL}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ idempotencyKey, items }),
  });
  return { status: res.status, body: await res.json() };
}

export async function getHealth(path = '/health') {
  const res = await fetch(`${API_URL}${path}`);
  return res.status;
}

const authHeader = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

/** GET /products，返回 { status, body } */
export async function getProducts() {
  const res = await fetch(`${API_URL}/products`);
  return { status: res.status, body: await res.json() };
}

/** POST /products，token 传 null 表示不带凭证 */
export async function postProduct({ token, name, price, stock }) {
  const res = await fetch(`${API_URL}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(token) },
    body: JSON.stringify({ name, price, stock }),
  });
  return { status: res.status, body: await res.json() };
}

/** GET /orders/:id，token 传 null 表示不带凭证 */
export async function getOrderById({ token, orderId }) {
  const res = await fetch(`${API_URL}/orders/${orderId}`, {
    headers: authHeader(token),
  });
  return { status: res.status, body: await res.json() };
}

