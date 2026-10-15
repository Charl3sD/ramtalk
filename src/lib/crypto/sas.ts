// Short authentication string: both screens show the same emoji only if both sides derived the
// same keys from the same pair of QR codes.

const EMOJI = [
  '🐶', '🐱', '🦁', '🐴', '🦄', '🐷', '🐘', '🐰',
  '🐼', '🐓', '🐧', '🐢', '🐟', '🐙', '🦋', '🌷',
  '🌳', '🌵', '🍄', '🌏', '🌙', '☁️', '🔥', '🍌',
  '🍎', '🍓', '🌽', '🍕', '🎂', '❤️', '😀', '🤖',
  '🎩', '👓', '🔧', '🎅', '👍', '☂️', '⌛', '⏰',
  '🎁', '💡', '📕', '✏️', '📎', '✂️', '🔒', '🔑',
  '🔨', '☎️', '🏁', '🚂', '🚲', '✈️', '🚀', '🏆',
  '⚽', '🎸', '🎺', '🔔', '⚓', '🎧', '📁', '📌',
] as const;

export const SAS_LENGTH = 5;

export function sasEmoji(sas: Uint8Array<ArrayBuffer>): string[] {
  // Take 6 bits per emoji from the derived bytes (5 × 6 = 30 bits).
  let bits = 0n;
  for (const b of sas) bits = (bits << 8n) | BigInt(b);
  const total = BigInt(sas.length * 8);
  const out: string[] = [];
  for (let i = 0; i < SAS_LENGTH; i++) {
    const shift = total - BigInt((i + 1) * 6);
    out.push(EMOJI[Number((bits >> shift) & 63n)]!);
  }
  return out;
}
