import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, findByIdentifier } from '../repositories/userRepository.js';
import { HttpError } from '../httpError.js';
import { apiConfig } from '../config.js';

const { jwtSecret: JWT_SECRET, jwtExpiresIn: JWT_EXPIRES_IN } = apiConfig();
const BCRYPT_ROUNDS = 10;


function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export async function register({ username, email, password }) {
  if (typeof username !== 'string' || !username.trim() || typeof email !== 'string' || !email.trim()) {
    throw new HttpError(400, 'username 和 email 不能为空');
  }
  if (username.trim().length > 50 || email.trim().length > 255 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    throw new HttpError(400, 'username 最多 50 字符，email 必须为有效邮箱且最多 255 字符');
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
      throw new HttpError(409, '用户名或邮箱已被注册', 'USER_EXISTS');
    }
    throw err;
  }
}

export async function login({ identifier, password }) {
  if (typeof identifier !== 'string' || !identifier.trim() || typeof password !== 'string' || !password) {
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
