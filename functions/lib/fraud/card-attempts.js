const crypto = require('crypto')
const { Timestamp } = require('firebase-admin').firestore
const { logger } = require('../../context')

// one document per credit card attempt (forensics)
const ATTEMPTS_COLLECTION = 'card_attempts'
// one document per (store, key type, key value) holding recent attempts (velocity)
const VELOCITY_COLLECTION = 'card_velocity'

const RETENTION_DAYS = 90
// max attempts kept per velocity key document
const MAX_TRACKED_ATTEMPTS = 60

const VELOCITY_DEFAULTS = {
  mode: 'off',
  window_minutes: 60,
  max_attempts: 5,
  max_declined: 3,
  // the signal that distinguishes card testing from a busy household: many
  // different buyer identities shipping to the very same address
  address_window_minutes: 360,
  max_identities_per_address: 3
}

const hashKey = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').substr(0, 32)

/**
 * Normalizes an e-mail so trivial variations map to the same velocity key:
 * lowercase, trimmed, "+tag" removed, dots removed for Gmail.
 * @param {string} email
 * @returns {string|null}
 */
const normalizeEmail = (email) => {
  const parts = String(email || '').trim().toLowerCase().split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  let [local, domain] = parts
  local = local.split('+')[0]
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '')
  }
  return `${local}@${domain}`
}

/**
 * Fingerprints a delivery address as postal code + street number, which survives
 * the spelling variations a bot uses on the street name itself.
 * @param {object} [address] - E-Com Plus address (params.to or billing_address)
 * @returns {string|null} "01311300-1000" or null when there is no usable address
 */
const normalizeAddress = (address) => {
  if (!address) return null
  const zip = String(address.zip || address.postal_code || '').replace(/\D/g, '')
  if (zip.length < 8) return null
  const number = String(address.number || '').replace(/\s/g, '').toUpperCase() || 'SN'
  return `${zip}-${number}`
}

/**
 * Fingerprints the card without storing it: brand plus last four digits, as
 * reported by the storefront. Replaced by the PagBank response after the charge.
 * @param {object} [creditCard] - params.credit_card
 * @returns {string|null}
 */
const normalizeCard = (creditCard) => {
  if (!creditCard) return null
  const last = String(creditCard.last_digits || '').replace(/\D/g, '').slice(-4)
  if (last.length < 4) return null
  return `${String(creditCard.brand || '?').toLowerCase()}-${last}`
}

/**
 * Extracts the attempt context (who/where) from E-Com Plus create_transaction params.
 * `browser_ip` and `client_user_agent` are filled by the Modules API when available.
 * @param {object} params - E-Com Plus create_transaction params
 * @returns {object} attempt context
 */
const buildAttemptContext = (params) => {
  const { buyer = {}, amount = {} } = params
  const taxId = String(buyer.doc_number || buyer.registry_number || '').replace(/\D/g, '')
  const email = normalizeEmail(buyer.email)
  return {
    order_id: params.order_id || null,
    order_number: params.order_number || null,
    ip: params.browser_ip || null,
    user_agent: params.client_user_agent ? String(params.client_user_agent).substr(0, 300) : null,
    email,
    tax_id: taxId || null,
    // the buyer identity an address is counted against
    identity: taxId || email || null,
    address: normalizeAddress(params.to || params.billing_address),
    card_fingerprint: normalizeCard(params.credit_card),
    buyer_name: String(buyer.fullname || buyer.name || '').substr(0, 100) || null,
    amount: amount.total || 0,
    installments: params.installments_number || 1,
    channel_type: params.channel_type || null,
    domain: params.domain || null
  }
}

/**
 * Velocity keys tracked for an attempt. `rule` picks how the key is evaluated:
 * 'count' compares attempts/declines against the limits, 'identities' compares
 * how many distinct buyers used the key.
 * @param {object} context - from buildAttemptContext
 * @returns {Array<{ type: string, value: string, rule: string }>}
 */
const buildVelocityKeys = (context) => {
  const keys = []
  // an IP is legitimately shared by many buyers (carrier CGNAT, office, public
  // wifi), so only its declines count — that is the card-testing signal
  if (context.ip) keys.push({ type: 'ip', value: context.ip, rule: 'declines' })
  if (context.tax_id) keys.push({ type: 'tax_id', value: context.tax_id, rule: 'count' })
  if (context.email) keys.push({ type: 'email', value: context.email, rule: 'count' })
  if (context.card_fingerprint) keys.push({ type: 'card', value: context.card_fingerprint, rule: 'count' })
  if (context.address) keys.push({ type: 'address', value: context.address, rule: 'identities' })
  return keys
}

const velocityDocRef = (db, storeId, key) => {
  return db.collection(VELOCITY_COLLECTION).doc(`${storeId}_${key.type}_${hashKey(key.value)}`)
}

/**
 * Evaluates every key against the configured limits inside its window.
 * Entries recorded for blocked attempts are ignored, so a blocked buyer retrying
 * cannot extend their own lockout.
 * Never throws: on Firestore error returns an unflagged result so checkout is not blocked.
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {number} storeId
 * @param {Array<{ type, value, rule }>} keys
 * @param {object} [options] - overrides for VELOCITY_DEFAULTS
 * @returns {Promise<{ flagged: boolean, reasons: string[], counts: object }>}
 */
const checkVelocity = async (db, storeId, keys, options = {}) => {
  const result = { flagged: false, reasons: [], counts: {} }
  if (!keys.length) return result

  const cfg = { ...VELOCITY_DEFAULTS, ...options }
  const now = Date.now()
  const countSince = now - cfg.window_minutes * 60 * 1000
  const addressSince = now - cfg.address_window_minutes * 60 * 1000

  try {
    const snapshots = await db.getAll(...keys.map(key => velocityDocRef(db, storeId, key)))
    snapshots.forEach((snapshot, i) => {
      const { type, rule } = keys[i]
      const all = snapshot.exists ? (snapshot.data().attempts || []) : []
      // a blocked attempt must not feed the counters that blocked it
      const entries = all.filter(entry => !entry.blocked)

      if (rule === 'identities') {
        const recent = entries.filter(entry => entry.t >= addressSince)
        const identities = new Set(recent.map(entry => entry.who).filter(Boolean))
        result.counts[type] = { identities: identities.size, attempts: recent.length }
        if (identities.size >= cfg.max_identities_per_address) {
          result.reasons.push(`${type}:identities=${identities.size}`)
        }
        return
      }

      const recent = entries.filter(entry => entry.t >= countSince)
      const declined = recent.filter(entry => entry.declined).length
      result.counts[type] = { attempts: recent.length, declined }
      if (rule !== 'declines' && recent.length >= cfg.max_attempts) {
        result.reasons.push(`${type}:attempts=${recent.length}`)
      }
      if (declined >= cfg.max_declined) {
        result.reasons.push(`${type}:declined=${declined}`)
      }
    })
    result.flagged = result.reasons.length > 0
  } catch (err) {
    logger.warn('Card velocity check failed, skipping', { storeId, err: err.message })
  }
  return result
}

/**
 * Persists the attempt for forensics and appends it to each velocity key.
 * Never throws: logging must not break the checkout.
 * @param {import('firebase-admin').firestore.Firestore} db
 * @param {number} storeId
 * @param {object} attempt - context + outcome fields
 * @param {Array<{ type, value, rule }>} keys
 */
const recordAttempt = async (db, storeId, attempt, keys) => {
  const now = Date.now()
  const doc = {
    store_id: storeId,
    ...attempt,
    created_at: new Date(now).toISOString(),
    // for a Firestore TTL policy on `expires_at`
    expires_at: Timestamp.fromMillis(now + RETENTION_DAYS * 24 * 60 * 60 * 1000)
  }
  try {
    await db.collection(ATTEMPTS_COLLECTION).add(doc)
  } catch (err) {
    logger.warn('Could not save card attempt', { storeId, orderNumber: attempt.order_number, err: err.message })
  }

  if (!keys.length) return
  const entry = {
    t: now,
    declined: attempt.outcome === 'declined',
    blocked: attempt.outcome === 'blocked',
    who: attempt.identity ? hashKey(attempt.identity) : null,
    order: attempt.order_number || null
  }
  try {
    await db.runTransaction(async (transaction) => {
      const refs = keys.map(key => velocityDocRef(db, storeId, key))
      const snapshots = await transaction.getAll(...refs)
      snapshots.forEach((snapshot, i) => {
        const attempts = snapshot.exists ? (snapshot.data().attempts || []) : []
        attempts.push(entry)
        transaction.set(refs[i], {
          store_id: storeId,
          type: keys[i].type,
          attempts: attempts.slice(-MAX_TRACKED_ATTEMPTS),
          updated_at: new Date(now).toISOString()
        })
      })
    })
  } catch (err) {
    logger.warn('Could not update card velocity keys', { storeId, orderNumber: attempt.order_number, err: err.message })
  }
}

/**
 * Maps a PagBank charge status to an attempt outcome.
 * @param {string} chargeStatus
 * @returns {string}
 */
const outcomeFromChargeStatus = (chargeStatus) => {
  switch (chargeStatus) {
    case 'PAID':
    case 'AUTHORIZED':
      return 'approved'
    case 'DECLINED':
      return 'declined'
    case 'IN_ANALYSIS':
    case 'WAITING':
      return 'under_analysis'
    default:
      return 'unknown'
  }
}

/**
 * Extracts card and acquirer response details from a PagBank charge.
 * @param {object} charge - PagBank charge object
 * @returns {object}
 */
const parseChargeDetails = (charge) => {
  if (!charge) return {}
  const card = charge.payment_method && charge.payment_method.card
  const response = charge.payment_response || {}
  return {
    pagbank: {
      charge_id: charge.id || null,
      status: charge.status || null,
      response_code: response.code || null,
      response_message: response.message || null
    },
    card: card
      ? {
          brand: card.brand || null,
          first_digits: card.first_digits || null,
          last_digits: card.last_digits || null
        }
      : null
  }
}

module.exports = {
  VELOCITY_DEFAULTS,
  normalizeEmail,
  normalizeAddress,
  normalizeCard,
  buildAttemptContext,
  buildVelocityKeys,
  checkVelocity,
  recordAttempt,
  outcomeFromChargeStatus,
  parseChargeDetails
}
