const { hostingUri } = require('../../../__env')
const createPagbankAxios = require('../../../lib/pagseguro/axios-instance')
const { getConnectToken } = require('../../../lib/pagseguro/connect-token')
const getAppData = require('../../../lib/store-api/get-app-data')
const { logger } = require('../../../context')

exports.post = async ({ appSdk, admin }, req, res) => {
  // https://apx-mods.e-com.plus/api/v1/list_payments/schema.json?store_id=100
  const { params, application } = req.body
  const { storeId } = req

  const config = Object.assign({}, application.data, application.hidden_data)

  const pagbankToken = await getConnectToken(storeId, admin.firestore()) || config.pagbank_token
  if (!pagbankToken) {
    return res.status(409).send({
      error: 'NO_PAGBANK_TOKEN',
      message: 'Conta PagBank não conectada. Acesse as configurações do app para conectar.'
    })
  }

  const isSandbox = config.sandbox === true
  const pagbank = createPagbankAxios(pagbankToken, isSandbox)
  const scriptSuffix = isSandbox ? '-sandbox' : ''
  const scriptUri = `${hostingUri}/pagseguro-dp${scriptSuffix}.js?v=3`

  // https://apx-mods.e-com.plus/api/v1/list_payments/response_schema.json?store_id=100
  const response = {
    payment_gateways: []
  }

  // base gateway object shared by all methods
  const newGateway = () => ({
    intermediator: {
      name: 'PagBank',
      link: 'https://www.pagseguro.com.br/',
      code: 'pagseguro'
    },
    payment_url: 'https://www.pagseguro.com.br/',
    type: 'payment'
  })

  // try to get public key for card encryption
  let publicKey
  if (!config.credit_card || !config.credit_card.disabled) {
    try {
      const { data } = await pagbank.get('/public-keys/card')
      publicKey = data.public_key
    } catch (err) {
      // fallback: create a new public key
      try {
        const { data } = await pagbank.post('/public-keys', { type: 'card' })
        publicKey = data.public_key
      } catch (keyErr) {
        logger.warn('PagBank: could not get/create public key', { storeId, err: keyErr.message })
      }
    }
  }

  // --- Credit card ---
  if (!config.credit_card || !config.credit_card.disabled) {
    const ccConfig = config.credit_card || {}
    const ccLabel = ccConfig.label || 'Cartão de crédito'

    let onloadExpression = publicKey
      ? `window.pagbankPublicKey=${JSON.stringify(publicKey)};`
      : ''

    // 3DS: session is created here (valid for 30 min) and consumed by the client script;
    // the storefront re-runs list_payments when the gateway is selected, refreshing it
    const threedsMode = ccConfig.threeds || 'disabled'
    if (threedsMode !== 'disabled') {
      const threeds = {
        mode: threedsMode,
        env: isSandbox ? 'SANDBOX' : 'PROD',
        session: null,
        expires_at: null
      }
      try {
        const { data } = await pagbank.post('/checkout-sdk/sessions')
        threeds.session = data.session
        threeds.expires_at = data.expires_at || null
      } catch (err) {
        logger.warn('PagBank: could not create 3DS session', {
          storeId,
          status: err.response && err.response.status,
          err: err.message
        })
      }
      onloadExpression += `window.pagbankThreeds=${JSON.stringify(threeds)};`
    } else {
      onloadExpression += 'window.pagbankThreeds=null;'
    }

    const gateway = {
      ...newGateway(),
      label: ccLabel,
      payment_method: {
        code: 'credit_card',
        name: `${ccLabel} - PagBank`
      },
      js_client: {
        script_uri: scriptUri,
        onload_expression: onloadExpression,
        cc_brand: {
          function: 'pagbankGetBrand',
          is_promise: false
        },
        cc_hash: {
          function: 'pagbankEncryptCard',
          is_promise: true
        }
      }
    }

    // installment options
    const installments = config.installments_option
    if (installments && installments.max_number > 1) {
      const { max_number: maxNumber, min_installment: minInstallment = 5, tax_value: taxValue = 0, interest_free_installments: interestFree = 1 } = installments

      // expose the store-configured installments regardless of amount context
      // (eg. product listing pages call list_payments without an amount/total)
      response.installments_option = {
        min_installment: minInstallment,
        max_number: maxNumber,
        monthly_interest: taxValue
      }

      const total = params.amount && params.amount.total
      if (total) {
        gateway.installment_options = []
        for (let n = 2; n <= maxNumber; n++) {
          const hasInterest = n > interestFree && taxValue > 0
          let value
          if (hasInterest) {
            const monthlyRate = taxValue / 100
            value = total * monthlyRate * Math.pow(1 + monthlyRate, n) / (Math.pow(1 + monthlyRate, n) - 1)
          } else {
            value = total / n
          }
          value = Math.round(value * 100) / 100
          if (value >= (minInstallment || 5)) {
            gateway.installment_options.push({
              number: n,
              value,
              tax: hasInterest
            })
          }
        }
      }
    }

    // discount for credit card
    applyDiscount(config, 'credit_card', gateway, response, params)

    response.payment_gateways.push(gateway)
  }

  // --- Boleto ---
  if (!config.banking_billet || !config.banking_billet.disabled) {
    const boletoConfig = config.banking_billet || {}
    const boletoLabel = boletoConfig.label || 'Boleto bancário'
    const expirationDays = boletoConfig.expiration_days || 3
    const expirationDate = new Date()
    expirationDate.setDate(expirationDate.getDate() + expirationDays)

    const gateway = {
      ...newGateway(),
      label: boletoLabel,
      payment_method: {
        code: 'banking_billet',
        name: `${boletoLabel} - PagBank`
      },
      expiration_date: expirationDate.toISOString(),
      instruction_lines: {
        first: (boletoConfig.instruction_lines && boletoConfig.instruction_lines.first) || 'Atenção',
        second: (boletoConfig.instruction_lines && boletoConfig.instruction_lines.second) ||
          'Fique atento à data de vencimento do boleto.',
        third: 'Pague em qualquer casa lotérica.'
      }
    }

    applyDiscount(config, 'banking_billet', gateway, response, params)

    response.payment_gateways.push(gateway)
  }

  // --- PIX ---
  if (config.pix && !config.pix.disabled) {
    const pixConfig = config.pix
    const pixLabel = pixConfig.label || 'PIX'

    const gateway = {
      ...newGateway(),
      label: pixLabel,
      payment_method: {
        code: 'account_deposit',
        name: `${pixLabel} - PagBank`
      },
      icon: `${hostingUri}/pix-icon.png`
    }

    applyDiscount(config, 'account_deposit', gateway, response, params)

    response.payment_gateways.push(gateway)
  }

  // --- Payment link (Checkout PagBank) ---
  if (config.payment_link && config.payment_link.enable) {
    const linkLabel = config.payment_link.label || 'Link de pagamento PagBank'
    const gateway = {
      ...newGateway(),
      label: linkLabel,
      payment_method: {
        code: 'balance_on_intermediary',
        name: `${linkLabel} - PagBank`
      }
    }
    response.payment_gateways.push(gateway)
  }

  res.send(response)
}

/**
 * Applies discount configuration to a payment gateway and the response discount_option.
 */
const applyDiscount = (config, methodCode, gateway, response, params) => {
  const discount = config.discount
  if (!discount || !discount.value || discount.value <= 0) return
  if (!discount[methodCode]) return

  const { type, value, apply_at: applyAt, min_amount: minAmount } = discount
  const amount = params.amount || {}

  if (applyAt !== 'freight') {
    response.discount_option = {
      label: gateway.label,
      min_amount: minAmount,
      apply_at: applyAt || 'subtotal',
      type: type || 'percentage',
      value: value
    }
  }

  // check minimum amount
  if (minAmount && amount.total < minAmount) return

  gateway.discount = {
    apply_at: applyAt || 'subtotal',
    type: type || 'percentage',
    value
  }
}
