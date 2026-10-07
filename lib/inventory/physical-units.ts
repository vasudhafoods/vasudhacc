const PACK_MULTIPLIER_PATTERNS = [
  /\bpack\s*of\s*(\d+)\b/i,
  /\b(\d+)\s*[- ]?pack\b/i,
  /\bpack\s*x\s*(\d+)\b/i,
];

const BUNDLE_NAME = /\b(combo|bundle|variety|bestsellers?|medley|delights|assorted|boxes?)\b/i;

export function productPackMultiplier(name: string): number {
  for (const pattern of PACK_MULTIPLIER_PATTERNS) {
    const match = name.match(pattern);
    if (match) return Number(match[1]) || 1;
  }
  return 1;
}

export function isPhysicalUnitProduct(name: string): boolean {
  return productPackMultiplier(name) === 1 && !BUNDLE_NAME.test(name);
}

export function physicalUnitDisplayName(name: string): string {
  return name
    .replace(/\s*(?:[·|–—-]\s*)?pack\s+of\s+1\b.*$/i, "")
    .replace(/\s*\(\s*1\s*[- ]?pack\s*\)\s*$/i, "")
    .trim() || name;
}
