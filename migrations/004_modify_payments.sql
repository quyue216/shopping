-- 004_modify_payments.sql
-- 1) 允许 0 元支付：0 元订单可直接支付成功，无需第三方支付
-- 2) 防止订单重复支付：同一订单最多存在一条 status = 'succeeded' 的支付记录
--    （仍允许 pending/processing/failed 等多次支付尝试，故不能用普通 UNIQUE(order_id)）

ALTER TABLE payments DROP CONSTRAINT chk_payments_amount_positive;
ALTER TABLE payments ADD CONSTRAINT chk_payments_amount_non_negative CHECK (amount >= 0);

COMMENT ON COLUMN payments.amount IS '本次支付金额，单位：分；允许 0（0 元订单）';

CREATE UNIQUE INDEX uq_payments_one_succeeded_per_order
    ON payments (order_id)
    WHERE status = 'succeeded';
