/**
 * Chargeable weight = max(actual weight, dimensional weight), per requirement.
 * Dimensional weight uses the standard courier formula:
 *   (L_cm x W_cm x H_cm) / divisor
 *
 * CONFIRMED: SFT expects weight in KG. Shopify provides item weights in grams,
 * so each item's grams are divided by 1000 before being passed to SFT.
 *
 * ASSUMPTIONS — flagged in README as pending SFT confirmation:
 *   1. Divisor defaults to 5000 (common international courier standard) but SFT
 *      hasn't confirmed their actual divisor. It's admin-configurable (settingsStore)
 *      so it can be corrected without a code change once confirmed.
 *   2. Multi-item carts: dimensional weight is calculated per line item and summed
 *      across the cart, then compared against summed actual weight. This doesn't
 *      model multiple items being packed into one smaller shared box — there's no
 *      box-packing algorithm here. Reasonable default without real packing data;
 *      revisit if SFT calculates chargeable weight per-shipment differently.
 *   3. If a product is missing its dimension metafields, that item falls back to
 *      actual weight only (soft-fail) instead of blocking checkout entirely.
 *      "Mandatory" dimensions should be enforced where products are created in
 *      Shopify (metafield validation / merchant process), not by breaking a live
 *      checkout when data is momentarily missing.
 */

function computeChargeableWeightKg(items, dimensionsByProductId, divisor) {
  let totalActualKg = 0;
  let totalDimensionalKg = 0;
  const missingDimensions = [];

  for (const item of items) {
    const quantity = item.quantity || 1;
    const actualKg = ((item.grams || 0) / 1000) * quantity;
    totalActualKg += actualKg;

    const dims = dimensionsByProductId[item.product_id];
    if (dims && dims.lengthCm && dims.widthCm && dims.heightCm) {
      const perUnitDimKg = (dims.lengthCm * dims.widthCm * dims.heightCm) / divisor;
      totalDimensionalKg += perUnitDimKg * quantity;
    } else {
      missingDimensions.push(item.product_id || item.sku || item.name || 'unknown item');
    }
  }

  if (missingDimensions.length > 0) {
    console.warn('[dimensionalWeight] missing dimension metafields for:', missingDimensions.join(', '));
  }

  return {
    chargeableWeightKg: Math.max(totalActualKg, totalDimensionalKg),
    totalActualKg,
    totalDimensionalKg,
    missingDimensions,
  };
}

module.exports = { computeChargeableWeightKg };
