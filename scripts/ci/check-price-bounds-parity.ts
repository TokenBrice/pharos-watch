#!/usr/bin/env tsx
import { PEG_CURRENCY_VALUES } from "../../shared/types/core";
import {
  classifyPegClass,
  FX_RATE_BOUNDS,
  HARDCODED_PRICE_BOUNDS,
  normalizePegTypeFromCurrency,
} from "../../shared/lib/peg-price-bounds";

const failures: string[] = [];
const checked: string[] = [];

function hasHardcodedCoverage(pegType: string): boolean {
  return Object.keys(HARDCODED_PRICE_BOUNDS).some((key) => key !== "USD" && pegType.includes(key));
}

for (const pegCurrency of PEG_CURRENCY_VALUES) {
  const pegType = normalizePegTypeFromCurrency(pegCurrency);
  const pegClass = classifyPegClass(pegCurrency, pegType, false);
  if (pegClass !== "fiat_fx" && pegClass !== "commodity") continue;

  if (!pegType) {
    failures.push(`${pegCurrency}: classified ${pegClass} but has no normalized pegType`);
    continue;
  }

  checked.push(`${pegCurrency}:${pegType}`);

  if (!hasHardcodedCoverage(pegType)) {
    failures.push(`${pegCurrency}: missing HARDCODED_PRICE_BOUNDS coverage for ${pegType}`);
  }
  if (!FX_RATE_BOUNDS[pegType]) {
    failures.push(`${pegCurrency}: missing FX_RATE_BOUNDS coverage for ${pegType}`);
  }
}

// Magnitude sanity: the hardcoded last-resort max must stay within 10x of the
// FX-bound max in either direction. Catches order-of-magnitude typos (a RUB
// max of 50 instead of 0.5 once let ~4,000x-peg prices through when no FX
// reference was available). Mins are deliberately near-zero floors and are
// not asserted.
for (const [currency, [, hardcodedMax]] of Object.entries(HARDCODED_PRICE_BOUNDS)) {
  if (currency === "USD") continue;
  const pegType = normalizePegTypeFromCurrency(currency);
  const fxBounds = pegType ? FX_RATE_BOUNDS[pegType] : undefined;
  if (!fxBounds) continue;
  const ratio = hardcodedMax / fxBounds[1];
  if (ratio > 10 || ratio < 0.1) {
    failures.push(
      `${currency}: hardcoded max ${hardcodedMax} is ${ratio.toFixed(1)}x the FX-bound max ${fxBounds[1]} (allowed 0.1x-10x)`,
    );
  }
}

if (failures.length > 0) {
  console.error("Price-bound parity check failed:");
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log(`Price-bound parity check passed (${checked.length} fiat/commodity peg currencies).`);
