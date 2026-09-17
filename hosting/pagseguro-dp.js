/* global PagSeguro */

/**
 * PagBank Direct Payment — client-side integration script.
 * Loaded by the storefront checkout via list-payments js_client.
 * Defines window.pagbankEncryptCard and window.pagbankGetBrand.
 *
 * Globals set by list-payments onload_expression:
 * - window.pagbankPublicKey: public key for card encryption
 * - window.pagbankThreeds: { mode, env, session, expires_at } or null when 3DS is disabled
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

  // load PagBank SDK once
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

  // normalize card fields sent by the storefront (CreditCardForm)
  const parseCard = function (card) {
    let expYear = String(card.year || card.exp_year || '')
    if (expYear.length === 2) {
      expYear = '20' + expYear
    }
    return {
      number: String(card.number || '').replace(/\D/g, ''),
      holder: card.holder || card.holder_name || card.name || '',
      expMonth: String(card.month || card.exp_month || '').padStart(2, '0'),
      expYear,
      securityCode: String(card.cvc || card.cvv || card.security_code || '')
    }
  }

  const userError = function (code, userMsg) {
    const err = new Error(code)
    err.code = code
    // shown by the storefront after the generic "invalid card" message
    err.userMsg = userMsg
    return err
  }

  /**
   * Builds the authenticate3DS request from checkout data exposed by the storefront.
   */
  const buildThreedsRequest = function (card, holderName) {
    const checkout = window._checkout || window.storefrontApp || {}
    const customer = checkout.customer || {}
    const amount = checkout.amount || {}

    const data = {
      customer: {
        name: String(holderName || customer.display_name || '').substr(0, 100),
        email: String(customer.main_email || '').substr(0, 60)
      },
      paymentMethod: {
        type: 'CREDIT_CARD',
        installments: 1,
        card: {
          number: card.number,
          expMonth: card.expMonth,
          expYear: card.expYear,
          holder: { name: String(card.holder || '').substr(0, 30) }
        }
      },
      amount: {
        value: Math.round((amount.total || 0) * 100),
        currency: 'BRL'
      },
      dataOnly: false
    }

    // installments chosen in the card form (select rendered by the storefront)
    const installmentSelect = document.getElementById('credit-card-installment')
    const installments = installmentSelect && parseInt(installmentSelect.value, 10)
    if (installments > 1) {
      data.paymentMethod.installments = Math.min(installments, 12)
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
    const address = addresses.find(function (addr) { return addr.default }) || addresses[0]
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

    return { data }
  }

  /**
   * Runs the PagBank 3DS authentication when enabled for the store.
   * Resolves with { id, status } (id null when skipped) or rejects with a user-facing error.
   */
  const authenticateThreeds = function (card, holderName) {
    const config = window.pagbankThreeds
    if (!config || !config.mode || config.mode === 'disabled') {
      return Promise.resolve(null)
    }
    const isStrict = config.mode === 'strict'

    // in permissive mode the payment goes on without 3DS; in strict mode it stops here
    const skip = function (reason, userMsg) {
      if (isStrict) {
        return Promise.reject(userError(reason, userMsg))
      }
      console.warn('[PagBank] 3DS skipped:', reason)
      return Promise.resolve({ id: null, status: 'SKIPPED', reason })
    }

    const retryMsg = ' Não foi possível autenticar o cartão, recarregue a página e tente novamente.'
    if (!config.session) {
      return skip('NO_SESSION', retryMsg)
    }
    if (config.expires_at && Date.now() > Number(config.expires_at) * 1000) {
      return skip('SESSION_EXPIRED', retryMsg)
    }

    let request
    try {
      PagSeguro.setUp({ session: config.session, env: config.env || 'PROD' })
      request = buildThreedsRequest(card, holderName)
    } catch (err) {
      console.error(err)
      return skip('SETUP_ERROR', retryMsg)
    }
    if (request.data.amount.value < 100) {
      return skip('AMOUNT_TOO_LOW', ' O valor mínimo para autenticação do cartão é R$ 1,00.')
    }

    // the SDK renders the issuer challenge (OTP) itself before resolving
    return PagSeguro.authenticate3DS(request).then(function (result) {
      const status = result && result.status
      switch (status) {
        case 'AUTH_FLOW_COMPLETED':
        case 'REQUIRE_CHALLENGE': {
          const authStatus = (result && result.authenticationStatus) || 'UNKNOWN'
          if (!result || !result.id) {
            return skip('NO_AUTH_ID', retryMsg)
          }
          if (isStrict && authStatus !== 'AUTHENTICATED') {
            return Promise.reject(userError('NOT_AUTHENTICATED',
              ' O emissor do cartão não autenticou a transação, utilize outro cartão ou forma de pagamento.'))
          }
          return { id: result.id, status: authStatus }
        }
        case 'AUTH_NOT_SUPPORTED':
          return skip('NOT_SUPPORTED',
            ' Este cartão não suporta autenticação 3DS, utilize outro cartão ou forma de pagamento.')
        case 'CHANGE_PAYMENT_METHOD':
          // issuer denied authentication: refuse in both modes
          return Promise.reject(userError('CHANGE_PAYMENT_METHOD',
            ' A autenticação foi negada pelo emissor do cartão, utilize outro cartão ou forma de pagamento.'))
        default:
          return skip('UNKNOWN_STATUS_' + status, retryMsg)
      }
    }, function (err) {
      console.error(err)
      const detail = err && (err.detail || err.message)
      return skip('SDK_ERROR' + (detail ? ':' + detail : ''), retryMsg)
    })
  }

  /**
   * Encrypts card data using PagBank SDK, running 3DS first when enabled.
   * Called by cc_hash js_client config.
   * @param {object} card - { number, name, month, year, cvc }
   * @returns {Promise<string>} "ENCRYPTED // brand last4 // 3DS id status"
   */
  window.pagbankEncryptCard = function (card) {
    const parsedCard = parseCard(card)
    const publicKey = window.pagbankPublicKey
    if (!publicKey) {
      return Promise.reject(new Error('PagBank public key not loaded'))
    }

    return loadSdk()
      .then(function () {
        return authenticateThreeds(parsedCard, parsedCard.holder)
      })
      .then(function (threeds) {
        const result = PagSeguro.encryptCard({
          publicKey,
          holder: parsedCard.holder,
          number: parsedCard.number,
          expMonth: parsedCard.expMonth,
          expYear: parsedCard.expYear,
          securityCode: parsedCard.securityCode
        })

        if (result.hasErrors) {
          const messages = result.errors
            ? result.errors.map(function (e) { return e.message || e.code }).join('; ')
            : 'Card encryption failed'
          throw new Error(messages)
        }

        // append brand/last digits and 3DS result (all stripped server-side)
        const brand = window.pagbankGetBrand(card)
        let encrypted = result.encryptedCard
        if (brand) {
          encrypted += ' // ' + brand + ' ' + parsedCard.number.slice(-4)
        }
        if (threeds) {
          encrypted += ' // 3DS ' + (threeds.id || '-') + ' ' + threeds.status
          if (threeds.reason) {
            encrypted += ' ' + String(threeds.reason).replace(/[^\w:.-]/g, '_').substr(0, 120)
          }
        }
        return encrypted
      })
  }
})()
