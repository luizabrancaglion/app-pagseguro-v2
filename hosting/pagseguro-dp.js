/* global PagSeguro */

/**
 * PagBank Direct Payment — client-side integration script.
 * Loaded by the storefront checkout via list-payments js_client.
 * Defines window.pagbankEncryptCard and window.pagbankGetBrand.
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

  /**
   * Encrypts card data using PagBank SDK.
   * Called by cc_hash js_client config.
   * @param {object} card - { number, name, month, year, cvc } as sent by the
   *   storefront CreditCardForm; `cvv`/`security_code` accepted as fallbacks
   * @returns {Promise<string>} encrypted card string
   */
  window.pagbankEncryptCard = function (card) {
    return new Promise(function (resolve, reject) {
      const encrypt = function () {
        const publicKey = window.pagbankPublicKey
        if (!publicKey) {
          return reject(new Error('PagBank public key not loaded'))
        }

        // normalize year to 4 digits
        let expYear = String(card.year || card.exp_year || '')
        if (expYear.length === 2) {
          expYear = '20' + expYear
        }

        const expMonth = String(card.month || card.exp_month || '').padStart(2, '0')

        try {
          const result = PagSeguro.encryptCard({
            publicKey,
            holder: card.holder || card.holder_name || card.name || '',
            number: String(card.number || '').replace(/\D/g, ''),
            expMonth,
            expYear,
            securityCode: String(card.cvc || card.cvv || card.security_code || '')
          })

          if (result.hasErrors) {
            const messages = result.errors
              ? result.errors.map(function (e) { return e.message || e.code }).join('; ')
              : 'Card encryption failed'
            return reject(new Error(messages))
          }

          // append brand info for debugging (stripped server-side)
          const brand = window.pagbankGetBrand(card)
          const encrypted = result.encryptedCard +
            (brand ? ` // ${brand} ${String(card.number || '').replace(/\D/g, '').slice(-4)}` : '')

          resolve(encrypted)
        } catch (err) {
          reject(err)
        }
      }

      // load PagBank SDK if not already loaded
      if (typeof PagSeguro !== 'undefined') {
        return encrypt()
      }

      const script = document.createElement('script')
      script.src = sdkUrl
      script.onload = function () {
        encrypt()
      }
      script.onerror = function () {
        reject(new Error('Failed to load PagBank SDK'))
      }
      document.head.appendChild(script)
    })
  }
})()
