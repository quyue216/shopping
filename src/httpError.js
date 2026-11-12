/** 带 HTTP 状态码的业务错误，由全局错误处理转成响应 */
export class HttpError extends Error {
  constructor(status, message, code = { 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 404: 'NOT_FOUND', 409: 'CONFLICT' }[status] ?? 'INTERNAL_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
