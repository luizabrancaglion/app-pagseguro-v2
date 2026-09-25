const { logger } = require('../../context')

// segment appended to the card hash by hosting/pagseguro-dp.js
const HASH_PREFIX = '3DS '

/**
 * Parses the 3DS segment the client script appends to the card hash:
 * "3DS <id> <amount> <installments>".
 *
 * The client's own `authenticationStatus` is deliberately NOT trusted: in the
 * PagBank sandbox the SDK reported NOT_AUTHENTICATED for a charge that PagBank
 * then answered with authentication_method.status = AUTHENTICATED. Only the
 * charge response decides (see parseChargeAuthentication).
 *
 * @param {string} [rawHash] - params.credit_card.hash
 * @returns {{ encryptedCard: string, id: string|null, amount: number|null, installments: number|null }}
 */
const parseCardHash = (rawHash) => {
  const parts = rawHash ? String(rawHash).split(' // ') : []
  const result = { encryptedCard: parts[0] || '', id: null, amount: null, installments: null }
  const segment = parts.find(part => part.startsWith(HASH_PREFIX))
  if (!segment) return result
  const [, id, amount, installments] = segment.split(' ')
  if (id && id.startsWith('3DS_')) {
    result.id = id
    result.amount = Number(amount) || null
    result.installments = Number(installments) || null
  }
  return result
}

/**
 * True when the 3DS authentication was made for exactly this charge. PagBank
 * answers 400 INVALID AUTHENTICATION_METHOD.ID when the amount or the number of
 * installments differ from the ones authenticated, so sending a mismatched id
 * would just kill the sale.
 * @param {object} threeds - from parseCardHash
 * @param {number} chargeAmount - value in cents
 * @param {number} installments
 * @returns {boolean}
 */
const matchesCharge = (threeds, chargeAmount, installments) => {
  return threeds.amount === chargeAmount && threeds.installments === installments
}

/**
 * Reads the authentication verdict from a PagBank charge response.
 * @param {object} [charge] - data.charges[0]
 * @returns {{ type: string|null, status: string|null, authenticated: boolean }}
 */
const parseChargeAuthentication = (charge) => {
  const auth = charge && charge.payment_method && charge.payment_method.authentication_method
  return {
    type: (auth && auth.type) || null,
    status: (auth && auth.status) || null,
    authenticated: !!(auth && auth.status === 'AUTHENTICATED')
  }
}

/**
 * True when the error body is PagBank refusing the authentication id, which is
 * recoverable by charging again without it.
 * @param {object} [errResponse] - err.response.data
 * @returns {boolean}
 */
const isInvalidAuthenticationId = (errResponse) => {
  const messages = errResponse && errResponse.error_messages
  if (!Array.isArray(messages)) return false
  return messages.some(m => {
    const name = String(m.parameter_name || '')
    return name.indexOf('authentication_method') !== -1
  })
}

/**
 * Cancels a charge that went through without the authentication a strict store
 * requires. PagBank needs the amount on the cancel call.
 * @param {import('axios').AxiosInstance} pagbank
 * @param {string} chargeId
 * @param {number} amount - value in cents
 * @param {number} storeId
 * @returns {Promise<boolean>} true when the charge is no longer live
 */
const cancelCharge = async (pagbank, chargeId, amount, storeId) => {
  try {
    await pagbank.post(`/charges/${chargeId}/cancel`, {
      amount: { value: amount }
    })
    logger.info(`PagBank: charge ${chargeId} cancelled (3DS required)`, { storeId })
    return true
  } catch (err) {
    logger.error(`PagBank: could not cancel charge ${chargeId} after failed 3DS`, {
      storeId,
      status: err.response && err.response.status,
      response: err.response && err.response.data,
      err: err.message
    })
    return false
  }
}

/**
 * Captures a charge that was only pre-authorized, after PagBank confirmed the
 * authentication. Returns the updated charge, or null when the capture failed.
 * @param {import('axios').AxiosInstance} pagbank
 * @param {string} chargeId
 * @param {number} amount - value in cents
 * @param {number} storeId
 * @returns {Promise<object|null>}
 */
const captureCharge = async (pagbank, chargeId, amount, storeId) => {
  try {
    const { data } = await pagbank.post(`/charges/${chargeId}/capture`, {
      amount: { value: amount }
    })
    return data
  } catch (err) {
    logger.error(`PagBank: could not capture charge ${chargeId}`, {
      storeId,
      status: err.response && err.response.status,
      response: err.response && err.response.data,
      err: err.message
    })
    return null
  }
}

module.exports = {
  parseCardHash,
  captureCharge,
  matchesCharge,
  parseChargeAuthentication,
  isInvalidAuthenticationId,
  cancelCharge
}
