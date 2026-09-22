/**
 * Validates Brazilian tax IDs (CPF or CNPJ) by check digits.
 * Only the digits are considered, so formatted input ("123.456.789-09") is accepted.
 * @param {string} taxId - CPF (11 digits) or CNPJ (14 digits)
 * @returns {boolean} true when the check digits match
 */
const validateTaxId = (taxId) => {
  const digits = String(taxId || '').replace(/\D/g, '')
  if (digits.length === 11) {
    return validateCpf(digits)
  }
  if (digits.length === 14) {
    return validateCnpj(digits)
  }
  return false
}

const isRepeated = (digits) => /^(\d)\1+$/.test(digits)

const checkDigit = (digits, weights) => {
  const sum = weights.reduce((acc, weight, i) => acc + parseInt(digits.charAt(i), 10) * weight, 0)
  const rest = sum % 11
  return rest < 2 ? 0 : 11 - rest
}

const validateCpf = (cpf) => {
  if (isRepeated(cpf)) return false
  const d1 = checkDigit(cpf, [10, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = checkDigit(cpf, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  return cpf.charAt(9) === String(d1) && cpf.charAt(10) === String(d2)
}

const validateCnpj = (cnpj) => {
  if (isRepeated(cnpj)) return false
  const d1 = checkDigit(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = checkDigit(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return cnpj.charAt(12) === String(d1) && cnpj.charAt(13) === String(d2)
}

module.exports = validateTaxId
