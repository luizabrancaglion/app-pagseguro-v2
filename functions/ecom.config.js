const { baseUri, hostingUri } = require('./__env')

// https://developers.e-com.plus/docs/api/#/store/applications/
const app = {
  app_id: 110110,
  state: 'active',
  title: 'PagBank (PagSeguro v2)',
  slug: 'pagseguro-v2',
  version: require('./package.json').version || '1.0.0',
  type: 'external',
  authentication: true,
  auth_callback_uri: `${baseUri}/ecom/auth-callback`,
  auth_scope: {
    stores: ['GET'],
    procedures: ['POST'],
    products: ['GET'],
    orders: ['GET', 'POST', 'PATCH'],
    'orders/payments_history': ['GET', 'POST'],
    payments: ['POST']
  },
  modules: {
    list_payments: {
      enabled: true,
      endpoint: `${baseUri}/ecom/modules/list-payments`
    },
    create_transaction: {
      enabled: true,
      endpoint: `${baseUri}/ecom/modules/create-transaction`
    }
  },
  admin_settings: {
    pagbank_connect: {
      schema: {
        type: 'string',
        title: 'Conectar conta PagBank',
        description: `Para conectar sua conta PagBank, acesse: ${baseUri}/pagbank/connect/start?store_id={store_id} (substitua {store_id} pelo ID da sua loja)`
      },
      hide: false
    },
    pagbank_token: {
      schema: {
        type: 'string',
        maxLength: 255,
        title: 'Token PagBank',
        description: 'Token de autenticação Bearer da conta PagBank. Veja como obter: https://developer.pagbank.com.br/v1/reference/como-obter-token-de-autenticacao'
      },
      hide: true
    },
    sandbox: {
      schema: {
        type: 'boolean',
        default: false,
        title: 'Sandbox (ambiente de testes)',
        description: 'Ative para usar o ambiente sandbox do PagBank. Requer credenciais de sandbox separadas.'
      },
      hide: false
    },
    label: {
      schema: {
        type: 'string',
        maxLength: 50,
        title: 'Rótulo',
        description: 'Rótulo exibido para o método de pagamento no checkout (ex: "PagBank")'
      },
      hide: false
    },
    credit_card: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          disabled: {
            type: 'boolean',
            title: 'Desabilitar cartão de crédito',
            default: false
          },
          label: {
            type: 'string',
            maxLength: 50,
            title: 'Rótulo do cartão de crédito'
          },
          min_amount: {
            type: 'number',
            minimum: 0,
            title: 'Valor mínimo para cartão',
            description: 'Valor mínimo do pedido para habilitar pagamento com cartão'
          },
          threeds: {
            type: 'string',
            enum: ['disabled', 'permissive', 'strict'],
            default: 'disabled',
            title: 'Autenticação 3DS',
            description: 'disabled: sem 3DS. permissive: autentica quando o cartão permite e segue normalmente quando não permite. strict: só conclui a venda se o PagBank confirmar a autenticação do emissor — transfere o risco de fraude para o emissor, mas recusa cartão fora do 3DS.'
          }
        },
        title: 'Cartão de crédito'
      },
      hide: false
    },
    installments_option: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          max_number: {
            type: 'integer',
            minimum: 2,
            maximum: 999,
            title: 'Número máximo de parcelas',
            default: 12
          },
          min_installment: {
            type: 'number',
            minimum: 1,
            title: 'Valor mínimo por parcela (R$)',
            default: 5
          },
          tax_value: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            title: 'Taxa de juros ao mês (%)',
            description: 'Juros aplicados nas parcelas com juros. Use 0 para parcelas sem juros.',
            default: 0
          },
          interest_free_installments: {
            type: 'integer',
            minimum: 1,
            maximum: 999,
            title: 'Parcelas sem juros',
            description: 'Número de parcelas sem cobrança de juros',
            default: 1
          }
        },
        title: 'Opções de parcelamento'
      },
      hide: false
    },
    banking_billet: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          disabled: {
            type: 'boolean',
            title: 'Desabilitar boleto bancário',
            default: false
          },
          label: {
            type: 'string',
            maxLength: 50,
            title: 'Rótulo do boleto'
          },
          expiration_days: {
            type: 'integer',
            minimum: 1,
            maximum: 30,
            default: 3,
            title: 'Dias para vencimento do boleto'
          },
          min_amount: {
            type: 'number',
            minimum: 0,
            title: 'Valor mínimo para boleto'
          },
          instruction_lines: {
            type: 'object',
            additionalProperties: false,
            properties: {
              first: { type: 'string', maxLength: 75, title: 'Linha 1' },
              second: { type: 'string', maxLength: 75, title: 'Linha 2' }
            },
            title: 'Instruções do boleto'
          }
        },
        title: 'Boleto bancário'
      },
      hide: false
    },
    pix: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          disabled: {
            type: 'boolean',
            title: 'Desabilitar PIX',
            default: false
          },
          label: {
            type: 'string',
            maxLength: 50,
            title: 'Rótulo do PIX'
          },
          expiration_minutes: {
            type: 'integer',
            minimum: 1,
            maximum: 43200,
            default: 1440,
            title: 'Expiração do QR Code PIX (minutos)',
            description: 'Tempo em minutos para o QR Code PIX expirar. Padrão: 1440 (24 horas)'
          },
          min_amount: {
            type: 'number',
            minimum: 0,
            title: 'Valor mínimo para PIX'
          }
        },
        title: 'PIX'
      },
      hide: false
    },
    payment_link: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enable: {
            type: 'boolean',
            title: 'Habilitar link de pagamento PagBank',
            default: false
          },
          label: {
            type: 'string',
            maxLength: 50,
            title: 'Rótulo do link de pagamento'
          }
        },
        title: 'Link de pagamento (Checkout PagBank)'
      },
      hide: false
    },
    discount: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apply_at: {
            type: 'string',
            enum: ['total', 'subtotal', 'freight'],
            default: 'subtotal',
            title: 'Aplicar desconto em'
          },
          type: {
            type: 'string',
            enum: ['percentage', 'fixed'],
            default: 'percentage',
            title: 'Tipo de desconto'
          },
          value: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            title: 'Valor do desconto'
          },
          min_amount: {
            type: 'number',
            minimum: 0,
            title: 'Valor mínimo do pedido para aplicar desconto'
          },
          credit_card: {
            type: 'boolean',
            title: 'Desconto no cartão de crédito'
          },
          banking_billet: {
            type: 'boolean',
            title: 'Desconto no boleto'
          },
          account_deposit: {
            type: 'boolean',
            title: 'Desconto no PIX'
          }
        },
        title: 'Desconto'
      },
      hide: false
    }
  }
}

// list of procedures to install on merchant stores
const procedures = [
  {
    title: 'PagBank — Mudança de status do pedido',
    triggers: [
      {
        resource: 'orders',
        action: 'change',
        field: 'financial_status'
      }
    ],
    webhooks: [
      {
        api: {
          external_api: {
            uri: `${baseUri}/ecom/webhook`
          }
        },
        method: 'POST'
      }
    ]
  }
]

module.exports = { app, procedures }
