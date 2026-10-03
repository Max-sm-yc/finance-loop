const MAX_PACKAGE_UNITS = 1_000_000;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** Detect a printed inner-unit count such as "36 pk" or "24 count". */
export function parseReceiptPackageUnits(description) {
  const matches = [...String(description ?? '').matchAll(/\b(\d{1,7})\s*(?:pk|packs?|ct|count)\b/gi)];
  if (matches.length !== 1) return null;
  const units = Number(matches[0][1]);
  return Number.isSafeInteger(units) && units > 0 && units <= MAX_PACKAGE_UNITS ? units : null;
}

/** Round one Square-unit cost to the nearest minor unit and report package-total variance. */
export function calculatePackageUnitCostMinor(packageCostMinor, packageQuantity, unitsPerPackage, squareUnitCostMinor = null) {
  if (!Number.isSafeInteger(packageCostMinor) || packageCostMinor < 0 ||
      packageQuantity !== null && (!Number.isSafeInteger(packageQuantity) || packageQuantity < 1 || packageQuantity > MAX_PACKAGE_UNITS) ||
      !Number.isSafeInteger(unitsPerPackage) || unitsPerPackage < 1 || unitsPerPackage > MAX_PACKAGE_UNITS ||
      squareUnitCostMinor !== null && (!Number.isSafeInteger(squareUnitCostMinor) || squareUnitCostMinor < 0)) return null;

  const effectivePackageQuantity = BigInt(packageQuantity ?? 1);
  const packageCost = BigInt(packageCostMinor) * effectivePackageQuantity;
  if (packageCost > MAX_SAFE_MINOR) return null;
  const squareUnitCount = effectivePackageQuantity * BigInt(unitsPerPackage);
  const perSquareUnit = (2n * packageCost + squareUnitCount) / (2n * squareUnitCount);
  const appliedUnitCost = BigInt(squareUnitCostMinor ?? Number(perSquareUnit));
  const roundingDelta = appliedUnitCost * squareUnitCount - packageCost;
  const roundedUnitCostMinor = Number(perSquareUnit);
  const roundingDeltaMinor = packageQuantity === null ? null : Number(roundingDelta);
  const appliedUnitCostMinor = Number(appliedUnitCost);
  if (!Number.isSafeInteger(roundedUnitCostMinor) || !Number.isSafeInteger(appliedUnitCostMinor) || roundingDeltaMinor !== null && !Number.isSafeInteger(roundingDeltaMinor)) return null;
  return { unitCostMinor: roundedUnitCostMinor, appliedUnitCostMinor, roundingDeltaMinor, squareUnitCount: packageQuantity === null ? null : squareUnitCount.toString() };
}
