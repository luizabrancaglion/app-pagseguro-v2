/* global PagSeguro */

/**
 * PagBank Direct Payment — client-side integration script.
 * Loaded by the storefront checkout via list-payments js_client.
 * Defines window.pagbankEncryptCard and window.pagbankGetBrand.
 *
 * Globals set by list-payments onload_expression:
 * - window.pagbankPublicKey: public key for card encryption
 * - window.pagbankThreeds: { mode, env, session, expires_at } or null
 * Globals set by the storefront before running the onload_expression:
 * - window._checkout: { amount, customer, items }
 */
;(function () {
  const sdkUrl = 'https://assets.pagseguro.com.br/checkout-sdk-js/rc/dist/browser/pagseguro.min.js'

  // Card brand detection via regex (synchronous)
  const brands = [
    { name: 'visa', regex: /^4/ },
    { name: 'mastercard', regex: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/ },
    { name: 'amex', regex: /^3[47]/ },
    { name: 'diners', regex: /^3(0[0-5]|[68])/ },
    { name: 'discover', regex: /^6(011|5)/ },
    { name: 'hipercard', regex: /^(606282|3841)/ },
    { name: 'elo', regex: /^(4011|4312|4389|4514|4573|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/ },
    { name: 'jcb', regex: /^35/ }
  ]

  /**
   * Detects card brand from card number prefix.
   * Called by cc_brand js_client config.
   * @param {object} card - { number: string }
   * @returns {string} brand name (e.g. 'visa') or empty string
   */
  window.pagbankGetBrand = function (card) {
    const number = String(card.number || '').replace(/\D/g, '')
    for (let i = 0; i < brands.length; i++) {
      if (brands[i].regex.test(number)) {
        return brands[i].name
      }
    }
    return ''
  }

  let sdkPromise = null
  const loadSdk = function () {
    if (typeof PagSeguro !== 'undefined') {
      return Promise.resolve()
    }
    if (!sdkPromise) {
      sdkPromise = new Promise(function (resolve, reject) {
        const script = document.createElement('script')
        script.src = sdkUrl
        script.onload = resolve
        script.onerror = function () {
          sdkPromise = null
          reject(new Error('Failed to load PagBank SDK'))
        }
        document.head.appendChild(script)
      })
    }
    return sdkPromise
  }

  /**
   * Normalizes the card fields the storefront CreditCardForm sends:
   * { name, doc, number, cvc, month, year, brand }.
   */
  const parseCard = function (card) {
    let expYear = String(card.year || card.exp_year || '')
    if (expYear.length === 2) {
      expYear = '20' + expYear
    }
    return {
      number: String(card.number || '').replace(/\D/g, ''),
      holder: card.holder || card.holder_name || card.name || '',
      expMonth: String(card.month || card.exp_month || '').padStart(2, '0'),
      expYear: expYear,
      securityCode: String(card.cvc || card.cvv || card.security_code || '')
    }
  }

  /**
   * The exact amount and installments this checkout will charge. PagBank refuses
   * the authentication id when they differ from the charge (400
   * INVALID AUTHENTICATION_METHOD.ID), so both are read at submit time and
   * travel back to the server inside the hash for it to compare.
   * @returns {{ amount: number, installments: number }} amount in cents
   */
  const chargeContext = function () {
    const checkout = window._checkout || window.storefrontApp || {}
    const amount = checkout.amount || {}
    const total = typeof amount.total === 'number' ? amount.total : 0
    const select = document.getElementById('credit-card-installment')
    const parsed = select ? parseInt(select.value, 10) : 1
    return {
      amount: Math.round(total * 100),
      installments: parsed > 1 ? parsed : 1
    }
  }

  const userError = function (code, userMsg) {
    const err = new Error(code)
    err.code = code
    err.userMsg = userMsg
    return err
  }

  /**
   * Runs PagBank 3DS when the store enabled it.
   * Resolves with { id, amount, installments } or { skipped: reason }.
   *
   * The SDK's own `authenticationStatus` is deliberately ignored: PagBank has
   * answered `authentication_method.status = AUTHENTICATED` for flows where the
   * SDK reported NOT_AUTHENTICATED, so refusing here would reject good
   * customers. Only the charge response decides, on the server.
   */
  const authenticateThreeds = function (card, context) {
    const config = window.pagbankThreeds
    if (!config || !config.mode || config.mode === 'disabled' || !config.session) {
      return Promise.resolve(null)
    }
    // expires_at comes from PagBank in MILLISECONDS
    if (config.expires_at && Date.now() > Number(config.expires_at)) {
      return Promise.resolve({ skipped: 'SESSION_EXPIRED' })
    }
    if (context.amount < 100) {
      return Promise.resolve({ skipped: 'AMOUNT_TOO_LOW' })
    }

    try {
      PagSeguro.setUp({ session: config.session, env: config.env || 'PROD' })
    } catch (err) {
      console.warn('[PagBank] 3DS setUp failed', err)
      return Promise.resolve({ skipped: 'SETUP_ERROR' })
    }

    const checkout = window._checkout || window.storefrontApp || {}
    const customer = checkout.customer || {}
    const data = {
      customer: {
        name: String(card.holder || customer.display_name || '').substr(0, 100),
        email: String(customer.main_email || '').substr(0, 60)
      },
      paymentMethod: {
        type: 'CREDIT_CARD',
        installments: context.installments,
        card: {
          number: card.number,
          expMonth: card.expMonth,
          expYear: card.expYear,
          holder: { name: String(card.holder || '').substr(0, 30) }
        }
      },
      amount: { value: context.amount, currency: 'BRL' },
      dataOnly: false
    }

    const phone = customer.phones && customer.phones[0]
    const phoneNumber = phone && String(phone.number || '').replace(/\D/g, '')
    if (phoneNumber && phoneNumber.length >= 10) {
      data.customer.phones = [{
        country: '55',
        area: phoneNumber.substr(0, 2),
        number: phoneNumber.substr(2),
        type: 'MOBILE'
      }]
    }

    const addresses = customer.addresses || []
    const address = addresses.filter(function (a) { return a.default })[0] || addresses[0]
    if (address && address.zip) {
      const parsed = {
        street: String(address.street || '').substr(0, 100),
        number: String(address.number || 'SN').substr(0, 20),
        city: String(address.city || '').substr(0, 90),
        regionCode: String(address.province_code || '').substr(0, 2).toUpperCase(),
        country: 'BRA',
        postalCode: String(address.zip || '').replace(/\D/g, '').substr(0, 8)
      }
      if (address.complement) {
        parsed.complement = String(address.complement).substr(0, 40)
      }
      data.billingAddress = parsed
      data.shippingAddress = parsed
    }

    return PagSeguro.authenticate3DS({ data: data }).then(function (result) {
      const status = result && result.status
      if (status === 'CHANGE_PAYMENT_METHOD') {
        throw userError('CHANGE_PAYMENT_METHOD',
          ' A autenticação foi negada pelo emissor do cartão, utilize outro cartão ou forma de pagamento.')
      }
      if (result && result.id) {
        return { id: result.id, amount: context.amount, installments: context.installments }
      }
      // AUTH_NOT_SUPPORTED, an unfinished REQUIRE_* state, or anything new
      return { skipped: status || 'NO_ID' }
    }, function (err) {
      if (err && err.code === 'CHANGE_PAYMENT_METHOD') {
        throw err
      }
      console.warn('[PagBank] 3DS error', err && (err.detail || err.message))
      return { skipped: 'SDK_ERROR' }
    })
  }

  /**
   * Encrypts card data using the PagBank SDK, running 3DS first when enabled.
   * Called by cc_hash js_client config.
   * @param {object} card - { number, name, month, year, cvc } from the storefront
   * @returns {Promise<string>} "ENCRYPTED // brand last4 [// 3DS <id> <amount> <installments>]"
   */
  window.pagbankEncryptCard = function (card) {
    const publicKey = window.pagbankPublicKey
    if (!publicKey) {
      return Promise.reject(new Error('PagBank public key not loaded'))
    }
    const parsed = parseCard(card)
    const context = chargeContext()

    return loadSdk()
      .then(function () {
        return authenticateThreeds(parsed, context)
      })
      .then(function (threeds) {
        const result = PagSeguro.encryptCard({
          publicKey: publicKey,
          holder: parsed.holder,
          number: parsed.number,
          expMonth: parsed.expMonth,
          expYear: parsed.expYear,
          securityCode: parsed.securityCode
        })

        if (result.hasErrors) {
          const messages = result.errors
            ? result.errors.map(function (e) { return e.message || e.code }).join('; ')
            : 'Card encryption failed'
          throw new Error(messages)
        }

        // brand and 3DS data are appended to the hash and stripped server-side
        const brand = window.pagbankGetBrand(card)
        let encrypted = result.encryptedCard
        if (brand) {
          encrypted += ' // ' + brand + ' ' + parsed.number.slice(-4)
        }
        if (threeds && threeds.id) {
          encrypted += ' // 3DS ' + threeds.id + ' ' + threeds.amount + ' ' + threeds.installments
        } else if (threeds && threeds.skipped) {
          console.warn('[PagBank] 3DS skipped:', threeds.skipped)
        }
        return encrypted
      })
  }
})()
