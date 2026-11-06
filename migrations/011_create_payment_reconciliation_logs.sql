-- 011_create_payment_reconciliation_logs.sql
-- 人工对账成功修复时写入审计记录；审计记录与业务修复在同一事务提交。
CREATE TABLE payment_reconciliation_logs (
    id                       BIGSERIAL    PRIMARY KEY,
    task_id                  BIGINT       NOT NULL UNIQUE REFERENCES payment_tasks(id) ON DELETE RESTRICT,
    payment_id               BIGINT       NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    order_id                 BIGINT       NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    operator                 VARCHAR(128) NOT NULL,
    idempotency_key          VARCHAR(128) NOT NULL,
    action                   VARCHAR(32)  NOT NULL,
    provider_status          VARCHAR(20)  NOT NULL,
    provider_amount          BIGINT       NOT NULL,
    provider_transaction_id  VARCHAR(128),
    provider_reason          TEXT,
    task_last_error          TEXT,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_reconciliation_operator_not_blank
        CHECK (length(btrim(operator)) > 0),
    CONSTRAINT chk_reconciliation_action
        CHECK (action IN ('payment_succeeded', 'payment_failed')),
    CONSTRAINT chk_reconciliation_provider_status
        CHECK (provider_status IN ('succeeded', 'failed')),
    CONSTRAINT chk_reconciliation_provider_amount_non_negative
        CHECK (provider_amount >= 0),
    CONSTRAINT chk_reconciliation_success_transaction_id
        CHECK (provider_status <> 'succeeded' OR
               (provider_transaction_id IS NOT NULL AND length(btrim(provider_transaction_id)) > 0))
);

CREATE INDEX idx_payment_reconciliation_logs_payment_created
    ON payment_reconciliation_logs (payment_id, created_at DESC);

COMMENT ON TABLE payment_reconciliation_logs IS
    '人工对账成功修复审计表；只记录已核实第三方终态并完成本地事务修复的操作';
COMMENT ON COLUMN payment_reconciliation_logs.task_id IS '被人工对账并完成收尾的死信任务；每个任务最多成功修复一次';
COMMENT ON COLUMN payment_reconciliation_logs.operator IS '执行人工对账的操作人';
COMMENT ON COLUMN payment_reconciliation_logs.idempotency_key IS '向第三方查询时使用的原支付幂等键';
COMMENT ON COLUMN payment_reconciliation_logs.action IS 'payment_succeeded 支付成功修复；payment_failed 支付失败修复';
COMMENT ON COLUMN payment_reconciliation_logs.provider_amount IS '第三方确认金额，单位：分';
COMMENT ON COLUMN payment_reconciliation_logs.task_last_error IS '修复前死信任务记录的最终错误原因';
