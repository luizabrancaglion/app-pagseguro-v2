const parseChargeStatus = require('../../lib/pagseguro/parse-status')
const { logger } = require('../../context')

exports.post = async ({ appSdk }, req, res) => {
  const payload = req.body

  // validate payload structure
  if (!payload || typeof payload !== 'object') {
    return res.sendStatus(204)
  }

  // PagBank sends the full order object with charges array
  const charges = payload.charges
  if (!charges || !Array.isArray(charges) || !charges.length) {
    return res.sendStatus(204)
  }

  const charge = charges[0]
  if (!charge || !charge.id || !charge.status) {
    return res.sendStatus(204)
  }

  // storeId is embedded in the notification URL as ?store_id=XXX
  const storeId = parseInt(req.query.store_id, 10)
  if (!storeId) {
    logger.warn('PagBank webhook: missing store_id in query string')
    return res.sendStatus(400)
  }

  const chargeId = charge.id
  const chargeStatus = charge.status
  const ecomStatus = parseChargeStatus(chargeStatus)

  // orderId is the PagBank order ID (ORDE_...), used as fallback for PIX lookup
  const orderId = payload.id

  logger.info(`PagBank webhook: charge ${chargeId} → ${chargeStatus} (${ecomStatus})`, {
    storeId,
    orderId
  })

  try {
    await updateOrderPaymentStatus(appSdk, storeId, chargeId, ecomStatus, orderId)
    res.sendStatus(200)
  } catch (err) {
    if (err.name === 'NotFound') {
      logger.warn(`PagBank webhook: order not found for charge ${chargeId}`, { storeId })
      // retry after 5s (race condition with create-transaction)
      setTimeout(async () => {
        try {
          await updateOrderPaymentStatus(appSdk, storeId, chargeId, ecomStatus, orderId)
        } catch (retryErr) {
          logger.error('PagBank webhook retry failed', { storeId, chargeId, err: retryErr.message })
        }
      }, 5000)
      return res.sendStatus(200) // return 200 so PagBank doesn't keep retrying
    }
    logger.error('PagBank webhook error', { storeId, chargeId, err: err.message })
    res.status(500).send({ error: err.message })
  }
}

/**
 * Find order in E-Com Plus by charge ID and post payment status update.
 * Falls back to orderId (ORDE_...) lookup for PIX, where webhook sends CHAR_UUID
 * but we stored QRCO_UUID as transaction_code.
 * @throws {Error} with name='NotFound' if order not found
 */
const updateOrderPaymentStatus = async (appSdk, storeId, chargeId, ecomStatus, orderId) => {
  const fields = '_id,status,financial_status,transactions._id,transactions.status,transactions.intermediator'

  let orders
  const result = await appSdk.apiRequest(
    storeId,
    `orders.json?transactions.intermediator.transaction_code=${chargeId}&fields=${fields}`,
    'GET'
  )
  orders = result && result.response && result.response.data && result.response.data.result

  // PIX fallback: webhook sends CHAR_UUID but we stored ORDE_UUID as transaction_reference
  if ((!orders || !orders.length) && orderId) {
    const result2 = await appSdk.apiRequest(
      storeId,
      `orders.json?transactions.intermediator.transaction_reference=${orderId}&fields=${fields}`,
      'GET'
    )
    orders = result2 && result2.response && result2.response.data && result2.response.data.result
  }

  if (!orders || !orders.length) {
    const err = new Error(`No order found for charge ${chargeId}`)
    err.name = 'NotFound'
    throw err
  }

  const order = orders[0]

  // find the matching transaction (by chargeId, or by orderId for PIX fallback)
  let matchTransaction = order.transactions && order.transactions.find(t => {
    return t.intermediator && t.intermediator.transaction_code === chargeId
  })
  if (!matchTransaction && orderId) {
    matchTransaction = order.transactions && order.transactions.find(t => {
      return t.intermediator && t.intermediator.transaction_reference === orderId
    })
  }

  if (!matchTransaction) {
    const err = new Error(`Transaction ${chargeId} not found in order ${order._id}`)
    err.name = 'NotFound'
    throw err
  }

  // idempotency: skip the payments history entry if status is already up-to-date
  const currentStatus = matchTransaction.status && matchTransaction.status.current
  const financialStatus = order.financial_status && order.financial_status.current

  if (currentStatus === ecomStatus) {
    logger.info(`PagBank webhook: status already ${ecomStatus}, skipping`, { storeId, chargeId })
  } else if (financialStatus === ecomStatus && ['paid', 'voided', 'refunded'].includes(ecomStatus)) {
    logger.info(`PagBank webhook: financial status already ${ecomStatus}, skipping`, { storeId, chargeId })
  } else {
    // post payment history update
    await appSdk.apiRequest(
      storeId,
      `orders/${order._id}/payments_history.json`,
      'POST',
      {
        transaction_id: matchTransaction._id,
        date_time: new Date().toISOString(),
        status: ecomStatus,
        notification_code: chargeId,
        flags: ['pagseguro']
      }
    )

    logger.info(`PagBank webhook: updated order ${order._id} to ${ecomStatus}`, { storeId, chargeId })
  }

  // a charge declined or cancelled before ever being paid leaves the order open
  // with its items still holding stock; the platform only gives the quantities
  // back when the order itself is cancelled
  const wasPaid = PAID_STATUS.includes(currentStatus) || PAID_STATUS.includes(financialStatus)
  if (UNPAID_DEAD_STATUS.includes(ecomStatus) && !wasPaid) {
    await cancelUnpaidOrder(appSdk, storeId, order, chargeId)
  }
}

// statuses of a charge that died without ever being paid (card declined, PIX/boleto expired)
const UNPAID_DEAD_STATUS = ['unauthorized', 'voided']
const PAID_STATUS = ['paid', 'partially_paid']

/**
 * Cancel the E-Com Plus order so the platform returns the reserved stock.
 * Errors propagate: the handler answers 500 and a redelivered notification
 * retries only this step, since the payments history above is idempotent.
 */
const cancelUnpaidOrder = async (appSdk, storeId, order, chargeId) => {
  if (order.status === 'cancelled') {
    return
  }

  await appSdk.apiRequest(
    storeId,
    `orders/${order._id}.json`,
    'PATCH',
    { status: 'cancelled' }
  )
  logger.info(`PagBank webhook: order ${order._id} cancelled, stock returned`, { storeId, chargeId })
}
