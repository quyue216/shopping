import express from 'express';
import healthRouter from './routes/health.js';
import authRouter from './routes/auth.js';
import productsRouter from './routes/products.js';
import ordersRouter from './routes/orders.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// 测试台页面：http://localhost:3000/ （开发辅助工具）
app.use(express.static('public'));

app.use(healthRouter);
app.use(authRouter);
app.use(productsRouter);
app.use(ordersRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // 业务错误（HttpError）返回约定状态码和文案；未知错误只记日志，不外泄细节
  if (err.status) {
    return res.status(err.status).json({ status: 'error', message: err.message });
  }
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
