-- 012_extend_payment_reconciliation_logs.sql
-- 允许记录“第三方查无交易后，经人工确认重新排队”的审计事件。
ALTER TABLE payment_reconciliation_logs
    DROP CONSTRAINT payment_reconciliation_logs_task_id_key;

ALTER TABLE payment_reconciliation_logs
    ALTER COLUMN provider_amount DROP NOT NULL;

ALTER TABLE payment_reconciliation_logs
    ADD COLUMN task_attempts_before INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payment_reconciliation_logs
    DROP CONSTRAINT chk_reconciliation_action,
    DROP CONSTRAINT chk_reconciliation_provider_status;

ALTER TABLE payment_reconciliation_logs
    ADD CONSTRAINT chk_reconciliation_action
        CHECK (action IN ('payment_succeeded', 'payment_failed', 'task_requeued')),
    ADD CONSTRAINT chk_reconciliation_provider_status
        CHECK (provider_status IN ('succeeded', 'failed', 'not_found')),
    ADD CONSTRAINT chk_reconciliation_provider_amount_presence
        CHECK (
            (provider_status = 'not_found' AND provider_amount IS NULL)
            OR
            (provider_status IN ('succeeded', 'failed') AND provider_amount IS NOT NULL)
        ),
    ADD CONSTRAINT chk_reconciliation_task_attempts_non_negative
        CHECK (task_attempts_before >= 0);

CREATE INDEX idx_payment_reconciliation_logs_task_created
    ON payment_reconciliation_logs (task_id, created_at DESC);

COMMENT ON COLUMN payment_reconciliation_logs.task_attempts_before IS
    '人工操作前任务已尝试次数；重新排队会将任务 attempts 重置为 0';

COMMENT ON TABLE payment_reconciliation_logs IS
    '人工对账审计表；记录第三方终态修复，以及确认无交易后的人工重新排队';
COMMENT ON COLUMN payment_reconciliation_logs.task_id IS
    '被人工对账处理的死信任务；同一任务可保留多次人工处理历史';
COMMENT ON COLUMN payment_reconciliation_logs.action IS
    'payment_succeeded 支付成功修复；payment_failed 支付失败修复；task_requeued 查无交易后重新排队';
