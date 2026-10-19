import { describe, expect, it } from 'vitest';
import { normalizeEcMobile, normalizeEmail } from './index.js';

describe('normalizeEcMobile', () => {
  it.each([
    ['0991234567', '+593991234567'],
    ['991234567', '+593991234567'],
    ['593991234567', '+593991234567'],
    ['+593 99 123 4567', '+593991234567'],
    ['(099) 123-4567', '+593991234567'],
  ])('%s → %s', (input, out) => expect(normalizeEcMobile(input)).toBe(out));

  it.each(['042123456', '+59342123456', '09912345', '+1 555 123 4567', 'abc', '+593991234567; DROP'])(
    'rechaza %s',
    (input) => expect(normalizeEcMobile(input)).toBeNull(),
  );
});

describe('normalizeEmail', () => {
  it('normaliza mayúsculas y espacios', () => expect(normalizeEmail('  Ana@Correo.EC ')).toBe('ana@correo.ec'));
  it.each(['ana', 'ana@', '@x.com', 'a..b@x.com', 'a@x', 'a@-x.com', '<script>@x.com'])('rechaza %s', (e) =>
    expect(normalizeEmail(e)).toBeNull(),
  );
});
