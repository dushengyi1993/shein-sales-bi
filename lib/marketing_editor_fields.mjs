// Self-contained so the same resolver can run in the browser evaluation context.
export function resolveOrdinaryTierInputs(inputs) {
  const text = [...inputs].filter(input => /^(text|number)$/.test(input.type || 'text'));
  if (text.length !== 2) return null;
  const prices = text.filter(input => /_enroll_cost_price$/.test(input.id || '')
    || (!input.id && String(input.className || '').includes('ant-input-number-input')));
  const discounts = text.filter(input => /_enroll_cost_price_rate$/.test(input.id || '')
    || (!input.id && !String(input.className || '').includes('ant-input-number-input')));
  if (prices.length !== 1 || discounts.length !== 1 || prices[0] === discounts[0]) return null;
  return {priceInput: prices[0], discountInput: discounts[0]};
}
