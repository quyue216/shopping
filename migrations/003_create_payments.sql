-- 003_create_payments.sql
-- 金额使用整数“分”；整个文件由迁移脚本包在事务中执行。
-- 一个订单允许多次支付尝试；同一次支付请求重试必须复用幂等键。

CREATE TABLE payments (
    id                       BIGSERIAL    PRIMARY KEY,
    order_id                 BIGINT       NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
    idempotency_key          VARCHAR(128) NOT NULL,
    amount                   BIGINT       NOT NULL,
    status                   VARCHAR(20)  NOT NULL DEFAULT 'pending',
    provider_transaction_id  VARCHAR(128),
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT uq_payments_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT uq_payments_provider_transaction_id UNIQUE (provider_transaction_id),
    CONSTRAINT chk_payments_idempotency_key_not_blank
        CHECK (length(btrim(idempotency_key)) > 0),
    CONSTRAINT chk_payments_amount_positive CHECK (amount > 0),
    CONSTRAINT chk_payments_status
        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'unknown')),
    CONSTRAINT chk_payments_provider_transaction_id_not_blank
        CHECK (provider_transaction_id IS NULL OR length(btrim(provider_transaction_id)) > 0)
);

CREATE INDEX idx_payments_order_id ON payments (order_id);

COMMENT ON TABLE payments IS '支付记录表，一条记录代表一次支付尝试';
COMMENT ON COLUMN payments.id IS '支付记录 ID，自增主键';
COMMENT ON COLUMN payments.order_id IS '关联订单 ID，保留支付记录时禁止物理删除订单';
COMMENT ON COLUMN payments.idempotency_key IS '支付幂等键，全表唯一；同一次支付请求重试时复用';
COMMENT ON COLUMN payments.amount IS '本次支付金额，单位：分；业务层根据订单金额确定';
COMMENT ON COLUMN payments.status IS 'pending 待发起、processing 处理中、succeeded 成功、failed 失败、unknown 结果未知';
COMMENT ON COLUMN payments.provider_transaction_id IS '模拟支付平台交易编号，唯一；尚未取得时为 NULL';
COMMENT ON COLUMN payments.created_at IS '创建时间';
COMMENT ON COLUMN payments.updated_at IS '更新时间，更新时由触发器维护';

-- 复用 002 中的触发器函数，该函数只负责设置 NEW.updated_at。
CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION set_order_updated_at();

-- 金额匹配、状态流转和防止重复扣款由支付业务处理；
-- unknown 需要先向平台查询原交易结果，不能直接当作失败重新支付。
