import express from 'express';
import healthRouter from './routes/health.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(healthRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
