import jwt from 'jsonwebtoken';
import { apiConfig } from '../config.js';
import { HttpError } from '../httpError.js';

const { jwtSecret: JWT_SECRET } = apiConfig();

/** 校验 Authorization: Bearer <token>，通过后将 { id, username } 挂到 req.user */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, '缺少 Bearer token'));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: Number(payload.sub), username: payload.username };
    next();
  } catch {
    next(new HttpError(401, 'token 无效或已过期'));
  }
}
