-- 006_create_payment_tasks.sql
-- 支付事件任务队列表：支付状态变化产生任务，Worker 竞争领取并异步处理。
-- 领取语义：status='pending' 且 available_at <= now() 的任务可被领取；
-- 领取时设置 lease_until 并 version+1，写回时校验 version 拒绝旧 Worker（乐观锁）。

CREATE TABLE payment_tasks (
    id            BIGSERIAL    PRIMARY KEY,
    payment_id    BIGINT       NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    event_type    VARCHAR(64)  NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
    attempts      INTEGER      NOT NULL DEFAULT 0,
    available_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    lease_until   TIMESTAMPTZ,
    version       INTEGER      NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_payment_tasks_event_type_not_blank
        CHECK (length(btrim(event_type)) > 0),
    CONSTRAINT chk_payment_tasks_status
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    CONSTRAINT chk_payment_tasks_attempts_non_negative CHECK (attempts >= 0),
    CONSTRAINT chk_payment_tasks_version_non_negative CHECK (version >= 0)
);

-- 按支付记录查任务
CREATE INDEX idx_payment_tasks_payment_id ON payment_tasks (payment_id);

-- Worker 轮询领取：只索引待处理任务，按可领取时间排序（部分索引，保持小巧）
CREATE INDEX idx_payment_tasks_pending_available_at
    ON payment_tasks (available_at)
    WHERE status = 'pending';

COMMENT ON TABLE  payment_tasks                IS '支付事件任务队列表，Worker 竞争领取异步处理';
COMMENT ON COLUMN payment_tasks.id             IS '任务主键';
COMMENT ON COLUMN payment_tasks.payment_id     IS '关联支付记录 ID';
COMMENT ON COLUMN payment_tasks.event_type     IS '事件类型，例如 payment_requested';
COMMENT ON COLUMN payment_tasks.status         IS 'pending 待领取、processing 处理中、completed 已完成、failed 失败';
COMMENT ON COLUMN payment_tasks.attempts       IS '已尝试次数，不能为负';
COMMENT ON COLUMN payment_tasks.available_at   IS '最早可领取时间（重试退避时向后推迟）';
COMMENT ON COLUMN payment_tasks.lease_until    IS '领取租约到期时间，未领取为 NULL；到期未写回可被其他 Worker 重新领取';
COMMENT ON COLUMN payment_tasks.version        IS '每次领取递增，写回时校验以拒绝旧 Worker（乐观锁）';
COMMENT ON COLUMN payment_tasks.last_error     IS '最近一次失败原因，允许为空';
COMMENT ON COLUMN payment_tasks.created_at     IS '创建时间';
COMMENT ON COLUMN payment_tasks.updated_at     IS '更新时间，更新时由触发器维护';

-- 复用 002 中的触发器函数维护 updated_at
CREATE TRIGGER trg_payment_tasks_updated_at
BEFORE UPDATE ON payment_tasks
FOR EACH ROW EXECUTE FUNCTION set_order_updated_at();
