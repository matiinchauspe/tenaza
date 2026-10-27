/**
 * Ticket 12 (the human's approved logo, "pinch-glow"): the board header's
 * own mark, inline SVG — never an `<img>` pointing at a bundled asset
 * path, so it sizes and sits beside the `TENAZA` wordmark like any other
 * inline element, with no extra request. Dark version only: the Live
 * surface has no light theme at all (`tokens.css`'s own doc comment,
 * decision 04) — "otherwise dark" (the human's own instruction) is the
 * only branch this board ever takes.
 *
 * Source: `.yun/prototypes/tenaza-logo/variants/pinch-glow-dark.svg`,
 * used exactly as given — same viewBox, same shapes, same colors, same
 * gradient id (`tz-glow-dark`). The only translation is XML attribute
 * names to their JSX/DOM equivalents (`stop-color` → `stopColor`,
 * `stroke-width` → `strokeWidth`), which changes nothing about how it
 * renders.
 */
export function TenazaMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="app__logo-mark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="Tenaza"
    >
      <title>Tenaza</title>
      <defs>
        <radialGradient id="tz-glow-dark" cx="32" cy="32" r="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2DD4BF" stopOpacity=".45" />
          <stop offset="1" stopColor="#2DD4BF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <polygon points="6,16 27,27.5 27,36.5 6,48" fill="#E7ECF2" />
      <polygon points="58,16 37,27.5 37,36.5 58,48" fill="#E7ECF2" />
      <circle cx="32" cy="32" r="13" fill="url(#tz-glow-dark)" />
      <circle cx="32" cy="32" r="8.5" fill="none" stroke="#2DD4BF" strokeWidth="2" opacity=".35" />
      <circle cx="32" cy="32" r="5" fill="#2DD4BF" />
    </svg>
  );
}
