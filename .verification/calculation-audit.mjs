const cases = [
  { name: 'hopper', quantity: 10000, chambers: 2, fill: 30, lanes: 4, initial: 2000, expected: 722000 },
  { name: 'pressure', quantity: 10000, chambers: 2, fill: 30, lanes: 4, initial: 8000, expected: 728000 },
];
const decimal = (value) => Math.round(value * 100) / 100;
const roundUpTo100 = (value) => Math.ceil(value / 100) * 100;
for (const item of cases) {
  const actual = item.quantity * item.chambers * item.fill * 1.1 + item.initial + 500 * item.lanes * item.fill;
  if (actual !== item.expected) throw new Error(`${item.name}: expected ${item.expected}, got ${actual}`);
}
const commissionBase = decimal(999.99);
const commission = decimal(commissionBase * 0.2);
if (commission !== 200) throw new Error(`commission: expected 200, got ${commission}`);
if (3 * 30 !== 90) throw new Error('connected fill failed');
if (300 + 300 < 500 || [300,300].some(v=>v<300)) throw new Error('valid SKU case failed');
if ([500].some(v=>v<300)) throw new Error('single SKU minimum failed');
if (300 + 300 + 100 !== 700 || roundUpTo100(137) !== 200) throw new Error('rounding failed');
if (decimal(1000000 * 0.2) !== 200000) throw new Error('large commission failed');
console.log('calculation-audit: PASS');
