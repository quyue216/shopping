import { checkConnection } from '../repositories/healthRepository.js';
import { logger } from '../observability/logger.js';

export async function checkDatabaseHealth() {
  try {
    return await checkConnection();
  } catch (err) {
    // 详细错误留在服务端日志，不外泄给客户端
    logger.error('db.health_failed', { error: err });
    return false;
  }
}
