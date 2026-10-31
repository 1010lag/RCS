export function CoffeeArt() {
  return (
    <div className="coffee-art" aria-hidden="true">
      <svg className="coffee-illustration" viewBox="0 0 260 260" fill="none">
        <circle cx="128" cy="132" r="116" stroke="white" strokeOpacity=".035" />
        <circle cx="128" cy="132" r="89" stroke="white" strokeOpacity=".035" />
        <path
          d="M106 56C96 44 114 36 107 24M130 52C120 39 138 31 132 18"
          stroke="#77777F"
          strokeOpacity=".45"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <ellipse cx="123" cy="218" rx="74" ry="8" fill="#303033" />
        <path
          d="M177 101H190C224 101 224 158 190 158H177"
          stroke="#E10600"
          strokeWidth="12"
        />
        <path
          d="M62 84H184L178 171C177 193 155 204 123 204C91 204 69 193 68 171L62 84Z"
          fill="#E10600"
        />
        <ellipse
          cx="123"
          cy="84"
          rx="61"
          ry="12"
          fill="#86100B"
          stroke="#FF4238"
          strokeWidth="5"
        />
        <text
          x="123"
          y="156"
          textAnchor="middle"
          fill="white"
          fontFamily="Arial,sans-serif"
          fontSize="32"
          fontWeight="900"
          letterSpacing="-1.8"
        >
          RCS.
        </text>
        <path
          d="M222 42L225 49L232 52L225 55L222 62L219 55L212 52L219 49L222 42Z"
          fill="#FF5B50"
        />
      </svg>
      <span className="art-caption">BREW A BETTER DAY.</span>
    </div>
  );
}
