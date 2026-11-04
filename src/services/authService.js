import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, findByIdentifier } from '../repositories/userRepository.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
const BCRYPT_ROUNDS = 10;

if (JWT_SECRET === 'dev-only-secret-change-me') {
  console.warn('[auth] JWT_SECRET 未配置，正在使用开发默认值，生产环境必须设置 JWT_SECRET');
}

/** 带 HTTP 状态码的业务错误，由全局错误处理转成响应 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export async function register({ username, email, password }) {
  if (!username?.trim() || !email?.trim()) {
    throw new HttpError(400, 'username 和 email 不能为空');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, '密码至少 8 位');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const user = await createUser({ username: username.trim(), email: email.trim(), passwordHash });
    return { user, token: signToken(user) };
  } catch (err) {
    // 唯一约束冲突（username 或 email 已存在）
    if (err.code === '23505') {
      throw new HttpError(409, '用户名或邮箱已被注册');
    }
    throw err;
  }
}

export async function login({ identifier, password }) {
  if (!identifier || !password) {
    throw new HttpError(400, 'identifier 和 password 不能为空');
  }

  const user = await findByIdentifier(identifier.trim());
  // 用户不存在与密码错误返回同样的信息，避免泄露账号是否存在
  if (!user) {
    throw new HttpError(401, '用户名或密码错误');
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    throw new HttpError(401, '用户名或密码错误');
  }

  return { user: { id: user.id, username: user.username, email: user.email }, token: signToken(user) };
}
