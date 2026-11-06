/** 人工对账审计记录。写入必须与本地状态修复处于同一事务。 */

export async function insertReconciliationLog(client, {
  taskId,
  paymentId,
  orderId,
  operator,
  idempotencyKey,
  action,
  providerStatus,
  providerAmount,
  providerTransactionId = null,
  providerReason = null,
  taskLastError = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO payment_reconciliation_logs (
       task_id,
       payment_id,
       order_id,
       operator,
       idempotency_key,
       action,
       provider_status,
       provider_amount,
       provider_transaction_id,
       provider_reason,
       task_last_error
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, created_at`,
    [
      taskId,
      paymentId,
      orderId,
      operator,
      idempotencyKey,
      action,
      providerStatus,
      providerAmount,
      providerTransactionId,
      providerReason,
      taskLastError,
    ],
  );
  return rows[0];
}
