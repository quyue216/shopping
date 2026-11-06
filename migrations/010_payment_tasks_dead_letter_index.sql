-- 010_payment_tasks_dead_letter_index.sql
-- failed 任务作为死信队列保留；按失败时间查询待人工核查记录。
CREATE INDEX idx_payment_tasks_dead_letter_updated_at
    ON payment_tasks (updated_at, id)
    WHERE status = 'failed';

COMMENT ON COLUMN payment_tasks.last_error IS
    '最近一次失败原因；任务进入 failed（死信队列）时保存最终失败原因';
