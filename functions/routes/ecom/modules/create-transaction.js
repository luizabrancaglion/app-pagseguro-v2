const createPagbankAxios = require('../../../lib/pagseguro/axios-instance')
const buildOrderPayload = require('../../../lib/pagseguro/build-order-payload')
const { parseBoletoAddress } = require('../../../lib/pagseguro/build-order-payload')
const parseChargeStatus = require('../../../lib/pagseguro/parse-status')
const { getConnectToken } = require('../../../lib/pagseguro/connect-token')
const validateTaxId = require('../../../lib/fraud/validate-tax-id')
const {
  buildAttemptContext,
  buildVelocityKeys,
  checkVelocity,
  recordAttempt,
  outcomeFromChargeStatus,
  parseChargeDetails
} = require('../../../lib/fraud/card-attempts')
const { baseUri } = require('../../../__env')
const { logger } = require('../../../context')

exports.post = async ({ appSdk, admin }, req, res) => {
  // https://apx-mods.e-com.plus/api/v1/create_transaction/schema.json?store_id=100
  const { params, application } = req.body
  const { storeId } = req

  const config = Object.assign({}, application.data, application.hidden_data)

  const pagbankToken = await getConnectToken(storeId, admin.firestore()) || config.pagbank_token
  if (!pagbankToken) {
    return res.status(409).send({
      error: 'NO_PAGBANK_TOKEN',
      message: 'Conta PagBank não conectada'
    })
  }

  const isSandbox = config.sandbox === true
  const pagbank = createPagbankAxios(pagbankToken, isSandbox)

  const { buyer, to, billing_address: billingAddress, order_number: orderNumber } = params
  const methodCode = params.payment_method && params.payment_method.code

  // amount.total already accounts for discounts and freight
  const chargeAmount = Math.round((params.amount.total || 0) * 100)

  // build base order payload (items, customer, shipping)
  const basePayload = buildOrderPayload(params)
  // embed storeId in notification URL so webhook knows which store this charge belongs to
  basePayload.notification_urls = [`${baseUri}/pagseguro/webhook?store_id=${storeId}`]

  // credit card attempt context (who/where) for forensics and velocity checks
  let attempt = null
  let velocityKeys = []
  const saveAttempt = (outcome, details) => {
    if (!attempt) return Promise.resolve()
    return recordAttempt(admin.firestore(), storeId, { ...attempt, outcome, ...details }, velocityKeys)
  }

  try {
    let responseData
    let ecomTransaction

    switch (methodCode) {
      case 'credit_card': {
        // extract encrypted card hash (may come as "ENCRYPTED // BRAND cardnumber")
        const rawHash = params.credit_card && params.credit_card.hash
        const encryptedCard = rawHash && rawHash.includes(' // ')
          ? rawHash.split(' // ')[0]
          : rawHash

        if (!encryptedCard) {
          return res.status(400).send({
            error: 'MISSING_CARD_HASH',
            message: 'Hash do cartão criptografado não encontrado'
          })
        }

        const antifraud = config.antifraud || {}
        attempt = buildAttemptContext(params)
        velocityKeys = buildVelocityKeys(attempt)

        // reject invalid CPF/CNPJ before reaching PagBank
        if (antifraud.validate_tax_id !== false && !validateTaxId(attempt.tax_id)) {
          await saveAttempt('rejected', { reason: 'INVALID_TAX_ID' })
          return res.status(400).send({
            error: 'INVALID_TAX_ID',
            message: 'CPF/CNPJ inválido'
          })
        }

        // velocity: repeated attempts per IP / tax ID / e-mail / card, and
        // several different buyers shipping to the same address
        const velocityConfig = antifraud.velocity || {}
        const velocityMode = velocityConfig.mode || 'off'
        if (velocityMode !== 'off') {
          const velocity = await checkVelocity(admin.firestore(), storeId, velocityKeys, velocityConfig)
          attempt.velocity = { mode: velocityMode, ...velocity }
          if (velocity.flagged) {
            logger.warn(`Card velocity flagged for order #${orderNumber} (mode: ${velocityMode})`, {
              storeId,
              orderNumber,
              reasons: velocity.reasons,
              counts: velocity.counts
            })
            if (velocityMode === 'block') {
              await saveAttempt('blocked', { reason: 'VELOCITY' })
              return res.status(403).send({
                error: 'VELOCITY_LIMIT',
                message: 'Não foi possível processar o pagamento, entre em contato com a loja'
              })
            }
          }
        }

        const installmentsNumber = params.installments_number || 1
        const holderName = params.credit_card && params.credit_card.holder_name

        const charge = {
          reference_id: String(orderNumber).substr(0, 64),
          description: `Pedido #${orderNumber}`.substr(0, 64),
          amount: {
            value: chargeAmount,
            currency: 'BRL'
          },
          payment_method: {
            type: 'CREDIT_CARD',
            installments: installmentsNumber,
            capture: true,
            card: {
              encrypted: encryptedCard,
              store: false
            }
          }
        }

        if (holderName) {
          charge.payment_method.card.holder = {
            name: String(holderName).substr(0, 30),
            tax_id: String(buyer.doc_number || buyer.registry_number || '').replace(/\D/g, '')
          }
        }

        const { data } = await pagbank.post('/orders', {
          ...basePayload,
          charges: [charge]
        })

        responseData = data
        const responseCharge = data.charges && data.charges[0]
        const chargeId = responseCharge && responseCharge.id
        const chargeStatus = responseCharge && responseCharge.status

        await saveAttempt(outcomeFromChargeStatus(chargeStatus), {
          ...parseChargeDetails(responseCharge),
          pagbank_order_id: data.id || null
        })

        // installment value calculation
        const installmentValue = Math.round(chargeAmount / installmentsNumber) / 100
        const installmentsConfig = config.installments_option || {}
        const interestFree = installmentsConfig.interest_free_installments || 1
        const hasTax = installmentsNumber > interestFree && (installmentsConfig.tax_value || 0) > 0

        ecomTransaction = {
          amount: chargeAmount / 100,
          currency_id: 'BRL',
          creditor_fees: {
            installment: installmentsNumber,
            intermediation: responseCharge && responseCharge.amount && responseCharge.amount.fees
              ? (responseCharge.amount.fees.buyer_fees || 0) / 100
              : 0
          },
          installments: {
            number: installmentsNumber,
            tax: hasTax,
            total: chargeAmount / 100,
            value: installmentValue
          },
          intermediator: {
            payment_method: {
              code: 'credit_card',
              name: 'Cartão de Crédito'
            },
            transaction_id: chargeId,
            transaction_code: chargeId,
            transaction_reference: String(data.id || '')
          },
          status: {
            current: parseChargeStatus(chargeStatus),
            updated_at: new Date().toISOString()
          }
        }
        break
      }

      case 'banking_billet': {
        const boletoConfig = config.banking_billet || {}
        const expirationDays = boletoConfig.expiration_days || 3
        const dueDate = new Date()
        dueDate.setDate(dueDate.getDate() + expirationDays)
        const dueDateStr = dueDate.toISOString().substr(0, 10)

        const address = billingAddress || to
        if (!address) {
          return res.status(400).send({
            error: 'MISSING_ADDRESS',
            message: 'Endereço de cobrança necessário para boleto'
          })
        }

        const instructionLines = boletoConfig.instruction_lines || {}

        const charge = {
          reference_id: String(orderNumber).substr(0, 64),
          description: `Pedido #${orderNumber}`.substr(0, 64),
          amount: {
            value: chargeAmount,
            currency: 'BRL'
          },
          payment_method: {
            type: 'BOLETO',
            boleto: {
              template: 'COBRANCA',
              due_date: dueDateStr,
              days_until_expiration: String(expirationDays),
              holder: {
                name: String(buyer.fullname || buyer.name || '').substr(0, 100),
                tax_id: String(buyer.doc_number || buyer.registry_number || '').replace(/\D/g, ''),
                email: String(buyer.email || '').substr(0, 60),
                address: parseBoletoAddress(address)
              },
              instruction_lines: {
                line_1: instructionLines.first || 'Atenção: não receber após vencimento.',
                line_2: instructionLines.second || 'Pague em qualquer casa lotérica.'
              }
            }
          }
        }

        const { data } = await pagbank.post('/orders', {
          ...basePayload,
          charges: [charge]
        })

        responseData = data
        const responseCharge = data.charges && data.charges[0]
        const chargeId = responseCharge && responseCharge.id
        const chargeStatus = responseCharge && responseCharge.status
        const boletoData = responseCharge && responseCharge.payment_method && responseCharge.payment_method.boleto

        // find PDF link
        const links = responseCharge && responseCharge.links
        const pdfLink = links && links.find(l => l.media === 'application/pdf')
        const boletoUrl = (pdfLink && pdfLink.href) ||
          (links && links.find(l => l.rel === 'BOLETO.PDF') && links.find(l => l.rel === 'BOLETO.PDF').href)

        ecomTransaction = {
          amount: chargeAmount / 100,
          currency_id: 'BRL',
          installments: { number: 1 },
          banking_billet: {
            link: boletoUrl,
            code: boletoData && boletoData.formatted_barcode
          },
          payment_link: boletoUrl,
          intermediator: {
            payment_method: {
              code: 'banking_billet',
              name: 'Boleto Bancário'
            },
            transaction_id: chargeId,
            transaction_code: chargeId,
            transaction_reference: String(data.id || '')
          },
          status: {
            current: parseChargeStatus(chargeStatus),
            updated_at: new Date().toISOString()
          }
        }
        break
      }

      case 'account_deposit': {
        // PIX — uses qr_codes at order level, not charges
        const pixConfig = config.pix || {}
        const expirationMinutes = pixConfig.expiration_minutes || 1440
        const pixExpirationDate = new Date(Date.now() + expirationMinutes * 60 * 1000).toISOString()

        const { data } = await pagbank.post('/orders', {
          ...basePayload,
          qr_codes: [{
            amount: { value: chargeAmount },
            expiration_date: pixExpirationDate
          }]
        })

        responseData = data
        const qrCode = data.qr_codes && data.qr_codes[0]
        const chargeId = qrCode && qrCode.id
        const chargeStatus = qrCode && qrCode.status

        const qrLinks = qrCode && qrCode.links
        const qrPngLink = qrLinks &&
          (qrLinks.find(l => l.rel === 'QRCODE.PNG') || qrLinks.find(l => l.media === 'image/png'))

        ecomTransaction = {
          amount: chargeAmount / 100,
          currency_id: 'BRL',
          installments: { number: 1 },
          pix: {
            qr_code: qrCode && qrCode.text,
            qr_code_url: qrPngLink && qrPngLink.href
          },
          intermediator: {
            payment_method: {
              code: 'account_deposit',
              name: 'PIX'
            },
            transaction_id: chargeId,
            transaction_code: chargeId,
            transaction_reference: String(data.id || '')
          },
          status: {
            current: parseChargeStatus(chargeStatus),
            updated_at: new Date().toISOString()
          }
        }
        break
      }

      case 'balance_on_intermediary': {
        // PagBank Checkout link
        const checkoutPayload = {
          reference_id: String(orderNumber).substr(0, 64),
          customer: basePayload.customer,
          items: basePayload.items,
          payment_methods: [
            { type: 'CREDIT_CARD' },
            { type: 'BOLETO' },
            { type: 'PIX' }
          ],
          notification_urls: basePayload.notification_urls
        }

        const { data } = await pagbank.post('/checkouts', checkoutPayload)

        const links = data.links
        const payLink = links && (links.find(l => l.rel === 'PAY') || links.find(l => l.rel === 'CHECKOUT'))

        ecomTransaction = {
          amount: chargeAmount / 100,
          currency_id: 'BRL',
          installments: { number: 1 },
          payment_link: payLink && payLink.href,
          intermediator: {
            payment_method: {
              code: 'balance_on_intermediary',
              name: 'Link de pagamento PagBank'
            },
            transaction_id: data.id,
            transaction_code: data.id,
            transaction_reference: String(data.id || '')
          },
          status: {
            current: 'pending',
            updated_at: new Date().toISOString()
          }
        }

        return res.send({
          redirect_to_payment: true,
          transaction: ecomTransaction
        })
      }

      default:
        return res.status(400).send({
          error: 'UNSUPPORTED_PAYMENT_METHOD',
          message: `Método de pagamento não suportado: ${methodCode}`
        })
    }

    logger.info(`PagBank transaction created for order #${orderNumber}`, {
      storeId,
      method: methodCode,
      chargeId: ecomTransaction.intermediator && ecomTransaction.intermediator.transaction_id
    })

    res.send({
      redirect_to_payment: false,
      transaction: ecomTransaction
    })
  } catch (err) {
    const errResponse = err.response && err.response.data
    const status = err.response && err.response.status

    await saveAttempt('error', {
      reason: status ? `HTTP_${status}` : err.message,
      pagbank: errResponse
        ? { error_messages: errResponse.error_messages || errResponse.message || null }
        : null
    })

    logger.error('PagBank create transaction error', {
      storeId,
      orderNumber,
      method: methodCode,
      status,
      message: err.message,
      response: errResponse
    })

    if (status === 401) {
      return res.status(401).send({
        error: 'PAGBANK_AUTH_ERROR',
        message: 'Token PagBank inválido ou expirado'
      })
    }

    const errorMessages = errResponse && (errResponse.error_messages || errResponse.message)
    const errorDetail = Array.isArray(errorMessages)
      ? errorMessages.map(e => e.description || e.message || e).join('; ')
      : (typeof errorMessages === 'string' ? errorMessages : JSON.stringify(errResponse))

    if (status === 400 || status === 422) {
      return res.status(400).send({
        error: 'CREATE_TRANSACTION_ERR',
        message: `Erro ao criar transação no PagBank: ${errorDetail}`
      })
    }

    res.status(500).send({
      error: 'CREATE_TRANSACTION_ERR',
      message: err.message
    })
  }
}
