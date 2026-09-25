const createPagbankAxios = require('../../../lib/pagseguro/axios-instance')
const buildOrderPayload = require('../../../lib/pagseguro/build-order-payload')
const { parseBoletoAddress } = require('../../../lib/pagseguro/build-order-payload')
const parseChargeStatus = require('../../../lib/pagseguro/parse-status')
const { getConnectToken } = require('../../../lib/pagseguro/connect-token')
const {
  parseCardHash,
  matchesCharge,
  captureCharge,
  parseChargeAuthentication,
  isInvalidAuthenticationId,
  cancelCharge
} = require('../../../lib/pagseguro/threeds')
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

  try {
    let responseData
    let ecomTransaction

    switch (methodCode) {
      case 'credit_card': {
        // extract encrypted card hash, may carry brand and 3DS data appended
        // as "ENCRYPTED // brand last4 // 3DS <id> <amount> <installments>"
        const rawHash = params.credit_card && params.credit_card.hash
        const threeds = parseCardHash(rawHash)
        const encryptedCard = threeds.encryptedCard

        if (!encryptedCard) {
          return res.status(400).send({
            error: 'MISSING_CARD_HASH',
            message: 'Hash do cartão criptografado não encontrado'
          })
        }

        const installmentsNumber = params.installments_number || 1
        const holderName = params.credit_card && params.credit_card.holder_name

        const threedsMode = (config.credit_card && config.credit_card.threeds) || 'disabled'
        // PagBank answers 400 when the authenticated amount/installments differ
        // from the charge, so only send an id that matches this exact charge
        const useThreeds = threedsMode !== 'disabled' && threeds.id &&
          matchesCharge(threeds, chargeAmount, installmentsNumber)
        if (threedsMode !== 'disabled' && threeds.id && !useThreeds) {
          logger.warn(`PagBank: 3DS id ignored for order #${orderNumber}, does not match charge`, {
            storeId,
            authenticated: { amount: threeds.amount, installments: threeds.installments },
            charge: { amount: chargeAmount, installments: installmentsNumber }
          })
        }

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
            // strict stores only capture after PagBank confirms the issuer
            // authenticated the charge; capturing first and refunding later is
            // not reliable (PagBank answers refund_temporarily_unavailable)
            capture: threedsMode !== 'strict',
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

        if (useThreeds) {
          charge.payment_method.authentication_method = {
            type: 'THREEDS',
            id: threeds.id
          }
        }

        let data
        try {
          const response = await pagbank.post('/orders', {
            ...basePayload,
            charges: [charge]
          })
          data = response.data
        } catch (err) {
          // PagBank rejected the authentication id itself; a permissive store
          // would rather charge without 3DS than lose the sale
          if (!useThreeds || threedsMode === 'strict' ||
            !isInvalidAuthenticationId(err.response && err.response.data)) {
            throw err
          }
          logger.warn(`PagBank: retrying order #${orderNumber} without 3DS`, {
            storeId,
            response: err.response && err.response.data
          })
          delete charge.payment_method.authentication_method
          const retry = await pagbank.post('/orders', {
            ...basePayload,
            charges: [charge]
          })
          data = retry.data
        }

        responseData = data
        let responseCharge = data.charges && data.charges[0]
        const chargeId = responseCharge && responseCharge.id
        let chargeStatus = responseCharge && responseCharge.status

        // the authentication verdict comes from PagBank, never from the client:
        // the SDK may report NOT_AUTHENTICATED for a charge PagBank authenticates
        const authentication = parseChargeAuthentication(responseCharge)
        if (authentication.status) {
          logger.info(`PagBank: charge ${chargeId} authentication ${authentication.status}`, { storeId, orderNumber })
        }

        if (threedsMode === 'strict') {
          // the charge was only pre-authorized; capture it or let it go
          if (!authentication.authenticated || !chargeId) {
            if (chargeId && chargeStatus !== 'DECLINED') {
              await cancelCharge(pagbank, chargeId, chargeAmount, storeId)
            }
            return res.status(400).send({
              error: 'THREEDS_REQUIRED',
              message: 'Não foi possível autenticar o cartão junto ao emissor, utilize outro cartão ou forma de pagamento'
            })
          }
          const captured = await captureCharge(pagbank, chargeId, chargeAmount, storeId)
          if (!captured) {
            await cancelCharge(pagbank, chargeId, chargeAmount, storeId)
            return res.status(409).send({
              error: 'CAPTURE_FAILED',
              message: 'Não foi possível concluir a cobrança, tente novamente'
            })
          }
          responseCharge = captured
          chargeStatus = captured.status
        }

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
