/** 带 HTTP 状态码的业务错误，由全局错误处理转成响应 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
