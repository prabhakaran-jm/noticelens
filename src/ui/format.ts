export function formatGbp(amount: number): string {
  const whole = Math.round(amount * 100) % 100 === 0;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

export function formatSignedDifference(differenceGBP: number | null): string {
  if (differenceGBP === null) {
    return "Not stated";
  }
  if (differenceGBP === 0) {
    return "Unchanged";
  }
  const amount = formatGbp(Math.abs(differenceGBP));
  return differenceGBP < 0 ? `${amount} lower` : `${amount} higher`;
}
