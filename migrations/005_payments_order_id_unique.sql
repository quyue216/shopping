-- 005_payments_order_id_unique.sql
-- 支付设计调整：一个订单只允许一条支付记录。
-- 支付重试时由业务层 UPDATE 原行的状态/幂等键，不再插入新行。
-- 因此 004 的部分唯一索引（每订单最多一条 succeeded）变为冗余，删除。

ALTER TABLE payments
    ADD CONSTRAINT uq_payments_order_id UNIQUE (order_id);

DROP INDEX uq_payments_one_succeeded_per_order;

COMMENT ON TABLE payments IS '支付记录表，一个订单一条记录，重试时更新原行状态';
COMMENT ON COLUMN payments.order_id IS '关联订单 ID，唯一；保留支付记录时禁止物理删除订单';
COMMENT ON COLUMN payments.status IS 'pending 待发起、processing 处理中、succeeded 成功、failed 失败（可重试，重试更新本行）、unknown 结果未知';
