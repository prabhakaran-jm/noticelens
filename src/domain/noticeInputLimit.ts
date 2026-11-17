/**
 * Supported notice size. Past this bound, grounding and inspection withhold
 * every cloud-bound fact and the screen explains why. The bound is a character
 * count chosen on this workspace after measuring repeated copies of the
 * original energy sample (see docs/m1-follow-ups.md).
 *
 * Budget for that shape: grounding at most 250 ms, because it runs on each
 * edit, and inspection at most 500 ms, because inspection is debounced.
 * 8,000 characters met both on the sizing run (200 ms / 306 ms).
 * 10,000 characters met inspection and missed grounding on the confirmation
 * run (253 ms). 12,000 characters missed inspection (567 ms). 16 KB and
 * 24,000 characters missed both, so they are outside the supported size.
 */
export const MAX_SUPPORTED_NOTICE_CHARS = 8_000;

export const NOTICE_TOO_LONG_MESSAGE =
  "This notice is longer than the supported size (8,000 characters). Amounts, dates, and actions are withheld until the text is shorter. Nothing was sent.";

export function noticeExceedsSupportedSize(text: string): boolean {
  return text.length > MAX_SUPPORTED_NOTICE_CHARS;
}
