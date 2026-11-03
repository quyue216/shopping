import { checkConnection } from '../repositories/healthRepository.js';

export async function checkDatabaseHealth() {
  try {
    return await checkConnection();
  } catch (err) {
    // 详细错误留在服务端日志，不外泄给客户端
    console.error('Database health check failed:', err);
    return false;
  }
}
