// Example SVG from the 카드소설 제작소 artifact ("단서 1": dry umbrella, wet window): shows Claude the expected detail and structure.
export const SVG_EXAMPLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 640">
<defs>
<linearGradient id="wall" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#171d2b"/><stop offset="1" stop-color="#0f141f"/></linearGradient>
<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1226"/><stop offset="1" stop-color="#18253f"/></linearGradient>
<linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e2432"/><stop offset="1" stop-color="#05070c"/></linearGradient>
<linearGradient id="steel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2a3040"/><stop offset=".35" stop-color="#6b7488"/><stop offset=".5" stop-color="#3a4254"/><stop offset="1" stop-color="#1a1f2a"/></linearGradient>
<linearGradient id="umb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#05070c"/><stop offset=".45" stop-color="#1c2230"/><stop offset="1" stop-color="#05070c"/></linearGradient>
<linearGradient id="wood" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4a3018"/><stop offset=".5" stop-color="#8a5a2c"/><stop offset="1" stop-color="#3a2410"/></linearGradient>
<radialGradient id="warm"><stop offset="0" stop-color="#ffd8a0" stop-opacity=".22"/><stop offset="1" stop-color="#ffd8a0" stop-opacity="0"/></radialGradient>
<radialGradient id="wet"><stop offset="0" stop-color="#9fc4ff" stop-opacity=".18"/><stop offset="1" stop-color="#9fc4ff" stop-opacity="0"/></radialGradient>
<filter id="b"><feGaussianBlur stdDeviation="12"/></filter>
<filter id="b1"><feGaussianBlur stdDeviation="1.2"/></filter>
<pattern id="rain" width="64" height="130" patternUnits="userSpaceOnUse" patternTransform="rotate(10)"><line x1="12" y1="0" x2="12" y2="44" stroke="#bcd2f5" stroke-width="1.4" stroke-opacity=".28"/><line x1="44" y1="60" x2="44" y2="96" stroke="#bcd2f5" stroke-width="1" stroke-opacity=".2"/></pattern>
</defs>
<rect width="1080" height="640" fill="url(#wall)"/>
<rect x="0" y="520" width="1080" height="120" fill="url(#floor)"/>
<g>
<rect x="560" y="0" width="520" height="530" fill="#0b0f19"/>
<rect x="576" y="0" width="490" height="514" fill="url(#glass)"/>
<circle cx="700" cy="150" r="60" fill="#ffc878" opacity=".16" filter="url(#b)"/>
<circle cx="900" cy="260" r="46" fill="#8fd0ff" opacity=".16" filter="url(#b)"/>
<circle cx="1000" cy="120" r="34" fill="#ff8c8c" opacity=".12" filter="url(#b)"/>
<rect x="576" y="0" width="490" height="514" fill="url(#rain)"/>
<g fill="#cfe0ff" opacity=".55">
<ellipse cx="620" cy="90" rx="5" ry="8"/><ellipse cx="662" cy="140" rx="4" ry="6"/><ellipse cx="690" cy="60" rx="6" ry="9"/><ellipse cx="740" cy="210" rx="4" ry="7"/><ellipse cx="780" cy="120" rx="5" ry="8"/><ellipse cx="820" cy="330" rx="6" ry="10"/><ellipse cx="860" cy="70" rx="4" ry="6"/><ellipse cx="905" cy="180" rx="5" ry="8"/><ellipse cx="950" cy="400" rx="6" ry="9"/><ellipse cx="990" cy="240" rx="4" ry="7"/><ellipse cx="1030" cy="340" rx="5" ry="8"/><ellipse cx="640" cy="300" rx="6" ry="10"/><ellipse cx="710" cy="420" rx="4" ry="7"/><ellipse cx="760" cy="470" rx="5" ry="8"/><ellipse cx="880" cy="450" rx="4" ry="6"/><ellipse cx="1040" cy="480" rx="6" ry="9"/><ellipse cx="600" cy="440" rx="4" ry="7"/><ellipse cx="960" cy="60" rx="5" ry="8"/>
</g>
<g stroke="#cfe0ff" stroke-opacity=".3" stroke-width="2" stroke-linecap="round"><path d="M640 300 q-6 40 2 90"/><path d="M820 340 q8 50 -2 110"/><path d="M950 410 q-4 40 4 80"/><path d="M690 68 q-4 30 2 60"/></g>
<line x1="820" y1="0" x2="820" y2="514" stroke="#0b0f19" stroke-width="6"/>
<line x1="576" y1="250" x2="1066" y2="250" stroke="#0b0f19" stroke-width="6"/>
</g>
<ellipse cx="820" cy="580" rx="260" ry="40" fill="url(#wet)"/>
<g fill="#9fc4ff" opacity=".22"><ellipse cx="700" cy="590" rx="30" ry="5"/><ellipse cx="800" cy="612" rx="46" ry="7"/><ellipse cx="920" cy="596" rx="26" ry="4"/></g>
<circle cx="260" cy="120" r="260" fill="url(#warm)"/>
<g>
<rect x="300" y="380" width="130" height="220" rx="10" fill="url(#steel)"/>
<ellipse cx="365" cy="380" rx="65" ry="18" fill="#3a4254"/>
<ellipse cx="365" cy="380" rx="52" ry="12" fill="#0b0f19"/>
<ellipse cx="365" cy="600" rx="65" ry="16" fill="#05070c" opacity=".7"/>
<line x1="300" y1="440" x2="430" y2="440" stroke="#0b0f19" stroke-opacity=".5" stroke-width="3"/>
<line x1="300" y1="540" x2="430" y2="540" stroke="#0b0f19" stroke-opacity=".5" stroke-width="3"/>
</g>
<g>
<path d="M350 384 L344 120 L362 96 L380 120 L374 384 Z" fill="url(#umb)"/>
<path d="M352 380 L349 140" stroke="#3a4560" stroke-width="1.2" stroke-opacity=".8"/>
<path d="M358 380 L356 130" stroke="#0a0d14" stroke-width="1.2"/>
<path d="M366 380 L366 128" stroke="#3a4560" stroke-width="1" stroke-opacity=".6"/>
<path d="M372 380 L374 140" stroke="#0a0d14" stroke-width="1.2"/>
<rect x="346" y="250" width="32" height="14" rx="3" fill="#2b3142"/>
<circle cx="362" cy="257" r="3" fill="#8a94a8"/>
<rect x="356" y="60" width="12" height="40" rx="6" fill="url(#wood)"/>
<path d="M362 62 Q362 34 336 34 Q316 34 316 54" fill="none" stroke="url(#wood)" stroke-width="12" stroke-linecap="round"/>
<path d="M362 62 Q362 34 336 34 Q316 34 316 54" fill="none" stroke="#b07a44" stroke-width="2" stroke-opacity=".5" stroke-linecap="round" transform="translate(-2,-2)"/>
<circle cx="362" cy="96" r="6" fill="#8a94a8"/>
</g>
<ellipse cx="365" cy="600" rx="90" ry="12" fill="#000" opacity=".35" filter="url(#b1)"/>
<rect x="0" y="0" width="1080" height="640" fill="#000" opacity=".08"/>
</svg>`;
