const parseChargeStatus = require('../../lib/pagseguro/parse-status')
const { logger } = require('../../context')

// statuses the platform mirrors on order.financial_status, so a matching
// financial status is enough to treat the payments history as already updated
const ORDER_LEVEL_STATUS = ['paid', 'voided', 'refunded']
// statuses of a charge that died without ever being paid (card declined, PIX/boleto expired)
const UNPAID_DEAD_STATUS = ['unauthorized', 'voided']
// statuses that prove money never moved on a transaction or order; anything
// else (paid, partially_paid, in_dispute, refunded, partially_refunded...)
// means the merchant may already have shipped and cancellation is theirs to make
const NEVER_PAID_STATUS = ['pending', 'under_analysis', 'unauthorized', 'voided']

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
  const fields = '_id,status,financial_status,fulfillment_status,' +
    'transactions._id,transactions.status,transactions.intermediator'

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
  } else if (financialStatus === ecomStatus && ORDER_LEVEL_STATUS.includes(ecomStatus)) {
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
  if (UNPAID_DEAD_STATUS.includes(ecomStatus)) {
    const skipReason = getCancelSkipReason(order, matchTransaction, currentStatus, financialStatus)
    if (skipReason) {
      logger.info(`PagBank webhook: not cancelling order ${order._id}, ${skipReason}`, { storeId, chargeId })
    } else {
      await cancelUnpaidOrder(appSdk, storeId, order, chargeId)
    }
  }
}

const isNeverPaid = status => !status || NEVER_PAID_STATUS.includes(status)

/**
 * Decide whether the order can be cancelled on the app's own authority.
 * Returns a reason string to skip, or null when the order never held a payment,
 * has no other transaction still alive and nothing has left the warehouse.
 */
const getCancelSkipReason = (order, matchTransaction, currentStatus, financialStatus) => {
  if (order.status !== 'open') {
    return `order is ${order.status}`
  }
  if (!isNeverPaid(currentStatus) || !isNeverPaid(financialStatus)) {
    return `payment status is ${currentStatus} / ${financialStatus}`
  }
  const fulfillmentStatus = order.fulfillment_status && order.fulfillment_status.current
  if (fulfillmentStatus && fulfillmentStatus !== 'unfulfilled') {
    return `fulfillment status is ${fulfillmentStatus}`
  }
  // customer may have retried with another payment on the same order
  const otherTransactionAlive = order.transactions.some(t => {
    if (t === matchTransaction) return false
    const status = t.status && t.status.current
    return !UNPAID_DEAD_STATUS.includes(status)
  })
  if (otherTransactionAlive) {
    return 'another transaction is still alive'
  }
  return null
}

/**
 * Cancel the E-Com Plus order so the platform returns the reserved stock.
 * A 4xx from Store API is final (the same PATCH would fail again), so it is
 * only logged; other errors propagate, the handler answers 500 and the
 * redelivered notification retries only this step, since the payments
 * history above is idempotent.
 */
const cancelUnpaidOrder = async (appSdk, storeId, order, chargeId) => {
  try {
    await appSdk.apiRequest(
      storeId,
      `orders/${order._id}.json`,
      'PATCH',
      { status: 'cancelled' }
    )
  } catch (err) {
    const status = err.response && err.response.status
    if (status >= 400 && status < 500) {
      logger.error(`PagBank webhook: Store API refused cancelling order ${order._id}`, {
        storeId,
        chargeId,
        status,
        err: err.message
      })
      return
    }
    throw err
  }
  logger.info(`PagBank webhook: order ${order._id} cancelled, stock returned`, { storeId, chargeId })
}
