-- 009_create_payment_provider_ledger.sql
-- 模拟第三方支付平台的账本表：替代原来的进程内 Map。
-- 账本独立持久化后，跨进程/重启可查询原交易，才能演练"扣款成功后 Worker 崩溃"的恢复。
-- 幂等由 idempotency_key 唯一约束保证：同一幂等键只有首个写入生效，并发/重试抢写时
-- 由业务层 ON CONFLICT DO NOTHING + 回查获取首个结果，保证返回一致的交易记录。

CREATE TABLE payment_provider_ledger (
    id                       BIGSERIAL    PRIMARY KEY,
    idempotency_key          VARCHAR(128) NOT NULL,
    amount                   BIGINT       NOT NULL,
    status                   VARCHAR(20)  NOT NULL,
    provider_transaction_id  VARCHAR(128),
    reason                   TEXT,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_provider_ledger_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT uq_provider_ledger_transaction_id UNIQUE (provider_transaction_id),
    CONSTRAINT chk_provider_ledger_idempotency_key_not_blank
        CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT chk_provider_ledger_amount_positive CHECK (amount > 0),
    CONSTRAINT chk_provider_ledger_status
        CHECK (status IN ('succeeded', 'failed')),
    CONSTRAINT chk_provider_ledger_reason_when_failed
        CHECK (status <> 'failed' OR reason IS NOT NULL),
    CONSTRAINT chk_provider_ledger_txn_when_succeeded
        CHECK (status <> 'succeeded' OR provider_transaction_id IS NOT NULL)
);

COMMENT ON TABLE  payment_provider_ledger                        IS '模拟支付平台账本，持久化以便跨进程/重启查询原交易';
COMMENT ON COLUMN payment_provider_ledger.id                     IS '账本平台侧记录 ID，自增主键';
COMMENT ON COLUMN payment_provider_ledger.idempotency_key        IS '支付幂等键，全表唯一；平台侧幂等：同键只记一笔';
COMMENT ON COLUMN payment_provider_ledger.amount                 IS '交易金额，单位：分';
COMMENT ON COLUMN payment_provider_ledger.status                 IS 'succeeded 成功、failed 业务失败（如余额不足）';
COMMENT ON COLUMN payment_provider_ledger.provider_transaction_id IS '平台交易编号，唯一；仅成功时有值';
COMMENT ON COLUMN payment_provider_ledger.reason                 IS '失败原因；仅失败时有值';
COMMENT ON COLUMN payment_provider_ledger.created_at             IS '记账时间';

-- 平台交易编号生成序列：跨进程全局唯一且单调递增
CREATE SEQUENCE payment_provider_txn_seq;

COMMENT ON SEQUENCE payment_provider_txn_seq IS '模拟支付平台交易编号序号，provider_transaction_id = txn_<nextval>';
