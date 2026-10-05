const listedPrices: { names: string[]; rupees: number }[] = [
  { names: ["navagraian cookies", "navagraha cookies", "little millet cookies", "wheat fiber cookies", "foxtail millet cookies"], rupees: 70 },
  { names: ["little moringa millet", "pearl millet noodles", "foxtail millet noodles", "kodo millet noodles", "sorghum millet noodles", "finger millet noodles"], rupees: 120 },
  { names: ["idli sambar", "aloo jeera", "dal khichadi", "lemon rice"], rupees: 125 },
  { names: ["upma", "poha"], rupees: 99 },
  { names: ["puliyogare rice"], rupees: 150 },
  { names: ["gajar halwa", "moong dal halwa", "dudhi halwa"], rupees: 100 },
  { names: ["millet chikki", "peanut chikki", "20g peanut chikki"], rupees: 12 },
];

export function listedOfflineUnitPricePaisa(productName: string): number | null {
  const name = productName
    .replace(/\s*[·|–—-]\s*pack\s+of\s+\d+.*$/i, "")
    .replace(/\s*[·|–—]\s*F\d[\w-]*$/i, "")
    .trim()
    .toLowerCase();
  for (const price of listedPrices) {
    if (price.names.some((listedName) => name === listedName || name.startsWith(`${listedName} `))) return price.rupees * 100;
  }
  return null;
}
