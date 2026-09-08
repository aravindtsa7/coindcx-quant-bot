/** Normalize validated fixed-point evidence without arithmetic or a domain-specific precision limit. */
export function canonicalFixedPointIdentity(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('Identity requires a fixed-point decimal');
  const integer = (match[2] ?? '0').replace(/^0+(?!$)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  if (integer === '0' && fraction === '') return '0';
  return `${match[1] === '-' ? '-' : ''}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}
