-- 007_payment_tasks_unique_event.sql
-- 同一次支付、同一事件类型只允许一条任务，防止重复入队。
-- 重试通过更新原任务（attempts/available_at/lease_until）实现，而非插入新行。

ALTER TABLE payment_tasks
    ADD CONSTRAINT uq_payment_tasks_payment_event UNIQUE (payment_id, event_type);

COMMENT ON COLUMN payment_tasks.event_type IS '事件类型，例如 payment_requested；与 payment_id 组合唯一';
