(() => {
'use strict';

const svg = (body, className = '') => `<svg class="glyph${className ? ` ${className}` : ''}" viewBox="30 30 60 60" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// Drawn on a 24 grid in lighter lines, the way the system draws its own symbols.
const thin = (body, className = '') => `<svg class="glyph${className ? ` ${className}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const FOLDER_BACK = 'M38 70V46a4 4 0 0 1 4-4h10a4 4 0 0 1 3.2 1.6L58 47h20a4 4 0 0 1 4 4v2';
const GHOST = 'M0 29A29 29 0 0 1 58 29L58 57A2.5 2.5 0 0 1 53 57A6 6 0 0 0 41 57A3 3 0 0 1 35 57A6 6 0 0 0 23 57A3 3 0 0 1 17 57A6 6 0 0 0 5 57A2.5 2.5 0 0 1 0 57Z';

window.Glyphs = {
 folder: svg(`<path d="${FOLDER_BACK}"/><path class="folder-front" d="M38 53L82 53L82 72A4 4 0 0 1 78 76L42 76A4 4 0 0 1 38 72Z"/>`, 'glyph-folder'),
 folderAdd: svg('<path d="M66 76H42a4 4 0 0 1-4-4V46a4 4 0 0 1 4-4h10a4 4 0 0 1 3.2 1.6L58 47h20a4 4 0 0 1 4 4v8M38 53h44"/><path d="M78 65v14M71 72h14"/>', 'glyph-folder-add'),
 pin: svg('<path d="M52 39h16M55.5 39v12.5L49 59h22l-6.5-7.5V39M60 59v20"/>', 'glyph-pin'),
 // A pencil with a stroke of its own under the tip, so it can write a line when reached for.
 pencil: svg('<g class="pencil-body"><path d="M44 76l2.6-10.4 21.9-21.9a5.1 5.1 0 0 1 7.2 0l.6.6a5.1 5.1 0 0 1 0 7.2L54.4 73.4z"/><path d="M64.5 47.7l7.8 7.8"/></g><path class="pencil-line" d="M60 80h18"/>', 'glyph-pencil'),
 trash: svg('<path class="trash-lid" d="M40 45h40M53.5 45v-4.5a3.5 3.5 0 0 1 3.5-3.5h6a3.5 3.5 0 0 1 3.5 3.5V45"/><path d="M45 45l2.3 28.4a4 4 0 0 0 4 3.6h17.4a4 4 0 0 0 4-3.6L75 45M55.5 55v12M64.5 55v12"/>', 'glyph-trash'),
 plus: svg('<path d="M60 43v34M43 60h34"/>'),
 lock: svg('<rect x="43" y="55" width="34" height="25" rx="6"/><path d="M49 55v-6.5a11 11 0 0 1 22 0V55M60 64.5v6"/>'),
 // The same padlock with a shackle of its own, so it can swing open and snap shut.
 padlock: svg('<path class="lock-shackle" d="M49 55v-6.5a11 11 0 0 1 22 0V55"/><rect x="43" y="55" width="34" height="25" rx="6"/><path d="M60 64.5v6"/>', 'glyph-padlock'),
 shield: svg('<path d="M60 37.5 77 44v13c0 11-7 19.5-17 23-10-3.5-17-12-17-23V44z"/><path d="m52.5 59 5 5 10-10.5"/>'),
 shieldAlert: svg('<path d="M60 37.5 77 44v13c0 11-7 19.5-17 23-10-3.5-17-12-17-23V44z"/><path d="M60 50v11M60 69v.5"/>'),
 quote: '<svg class="glyph glyph-quote" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.2 6.3C6.6 7.6 4.4 10.4 4.4 14.1c0 2.4 1.5 4 3.5 4 1.8 0 3.2-1.3 3.2-3.1 0-1.7-1.2-2.9-2.8-2.9-.3 0-.6 0-.8.1.4-1.7 1.8-3.1 3.6-3.9zm9 0c-3.6 1.3-5.8 4.1-5.8 7.8 0 2.4 1.5 4 3.5 4 1.8 0 3.2-1.3 3.2-3.1 0-1.7-1.2-2.9-2.8-2.9-.3 0-.6 0-.8.1.4-1.7 1.8-3.1 3.6-3.9z"/></svg>',
 // A speech bubble with three dots of its own that show while what it stands for is folded away.
 bubble: svg('<path d="M60 38c-13 0-23 8.6-23 19.5 0 5.4 2.5 10.3 6.6 13.8L42 81l10.8-5.2c2.3.5 4.7.8 7.2.8 13 0 23-8.6 23-19.5S73 38 60 38z"/><path class="bubble-dot" d="M50.5 57.5h0"/><path class="bubble-dot" d="M60 57.5h0"/><path class="bubble-dot" d="M69.5 57.5h0"/>', 'glyph-bubble'),
 check: svg('<path d="m45 61 10 10 20-22"/>'),
 // Two pictures, one over the other. Reached for, the sun rises over the front one and the one behind it slides out a little.
 photo: thin('<path class="photo-back" d="M7.2 4.2h10.6a3 3 0 0 1 3 3v8.4"/><rect x="3.2" y="7.4" width="14.6" height="12.4" rx="2.8"/><circle class="photo-sun" cx="8" cy="11.8" r="1.4"/><path d="M3.5 18.4l4.3-4.3a1.4 1.4 0 0 1 2 0l5.6 5.6"/>', 'glyph-photo'),
 // A paper clip, one wire bent round twice. Reached for, it tips over.
 clip: thin('<g class="clip-wire"><path d="M10 8v8a2 2 0 0 0 4 0V5a3 3 0 0 0-6 0v13a4 4 0 0 0 8 0V8" transform="rotate(45 12 12)"/></g>', 'glyph-clip'),
 // A line pressed from above and below: a chat pressed into its summary. Reached for, the chevrons press closer.
 compact: thin('<path d="M5.5 12h13"/><path class="compact-a" d="M9 4.2l3 3 3-3"/><path class="compact-b" d="M9 19.8l3-3 3 3"/>', 'glyph-compact'),
 // Three bars like the stats card's own, rounded at both ends. Reached for, they trade heights.
 bars: '<svg class="glyph glyph-bars" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect class="bar-a" x="4.4" y="12" width="3.4" height="8" rx="1.7"/><rect class="bar-b" x="10.3" y="4.5" width="3.4" height="15.5" rx="1.7"/><rect class="bar-c" x="16.2" y="8.8" width="3.4" height="11.2" rx="1.7"/></svg>',
 terminal: svg('<rect x="36" y="40" width="48" height="40" rx="8"/><path d="m47 53 7 7-7 7M61 67h11"/>'),
 file: svg('<path d="M49 36h14l13 13v31a4 4 0 0 1-4 4H49a4 4 0 0 1-4-4V40a4 4 0 0 1 4-4z"/><path d="M62 36v14h14"/>'),
 globe: svg('<circle cx="60" cy="60" r="22"/><path d="M38.5 60h43M60 38c-6.5 6-10 13.5-10 22s3.5 16 10 22c6.5-6 10-13.5 10-22s-3.5-16-10-22z"/>'),
 // An eye for what a field hides; its slash draws across while the field shows it.
 eye: svg('<path d="M35 60c6-9.5 14.5-15 25-15s19 5.5 25 15c-6 9.5-14.5 15-25 15s-19-5.5-25-15z"/><circle cx="60" cy="60" r="6"/><path class="eye-slash" d="M42 42l36 36"/>', 'glyph-eye'),
 // KAI's own character (the matrix orb), replacing the OpenGhost ghost image.
 kai: `<svg class="glyph glyph-kai glyph-ghost" viewBox="0 0 400 420" role="img" aria-label="KAI"><defs>
<radialGradient id="halo-g"><stop id="hgs" offset=".6" stop-color="#4FB4FF" stop-opacity=".4"/><stop offset="1" stop-color="#4FB4FF" stop-opacity="0"/></radialGradient>
<radialGradient id="body" cx=".5" cy=".44" r=".53"><stop offset="0" stop-color="#1B5FE0"/><stop offset=".55" stop-color="#2E84F6"/><stop offset=".84" stop-color="#5CB8FF"/><stop offset=".95" stop-color="#A4E4FF"/><stop offset="1" stop-color="#E4F8FF"/></radialGradient>
<radialGradient id="under" cx=".5" cy=".95" r=".6"><stop offset="0" stop-color="#7FE0FF" stop-opacity=".5"/><stop offset="1" stop-color="#7FE0FF" stop-opacity="0"/></radialGradient>
<radialGradient id="deep" cx=".5" cy=".3" r=".75"><stop offset=".55" stop-color="#0B2A5E" stop-opacity="0"/><stop offset="1" stop-color="#0A3CB0" stop-opacity=".28"/></radialGradient>
<radialGradient id="hl"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="eg"><stop id="egs" offset="0" stop-color="#A8F3FF" stop-opacity=".75"/><stop offset="1" stop-color="#A8F3FF" stop-opacity="0"/></radialGradient>
<linearGradient id="ey" x1="0" y1="0" x2="0" y2="1"><stop id="eyt" offset="0" stop-color="#FFFFFF"/><stop id="eyb" offset="1" stop-color="#A9ECFF"/></linearGradient>
<radialGradient id="brg"><stop offset="0" stop-color="#fff"/><stop offset=".62" stop-color="#fff"/><stop offset=".88" stop-color="#DDF3FF"/><stop offset="1" stop-color="#86CCFF"/></radialGradient><linearGradient id="bkg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2604a"/><stop offset="1" stop-color="#a63628"/></linearGradient><radialGradient id="cgr"><stop offset="0" stop-color="#eafcff"/><stop offset=".4" stop-color="#8fdcff" stop-opacity=".55"/><stop offset="1" stop-color="#4fb4ff" stop-opacity="0"/></radialGradient><filter id="gw" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><radialGradient id="tng" cx=".5" cy="1.05" r=".78"><stop offset="0" style="stop-color:var(--tn)" stop-opacity=".9"/><stop offset="1" style="stop-color:var(--tn)" stop-opacity="0"/></radialGradient>
<radialGradient id="d3" gradientUnits="userSpaceOnUse" cx="-45" cy="-55" r="230"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".3" stop-color="#fff" stop-opacity=".06"/><stop offset=".6" stop-color="#02061a" stop-opacity="0"/><stop offset="1" stop-color="#0a3fb8" stop-opacity=".3"/></radialGradient>
<radialGradient id="r3" gradientUnits="userSpaceOnUse" cx="-20" cy="-25" r="168"><stop offset=".8" stop-color="#8fe6ff" stop-opacity="0"/><stop offset="1" stop-color="#8fe6ff" stop-opacity=".65"/></radialGradient>
<radialGradient id="shg" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#1F5FDB"/><stop offset=".6" stop-color="#2E80F4"/><stop offset=".92" stop-color="#63BCFF"/><stop offset="1" stop-color="#B9E8FF"/></radialGradient><radialGradient id="rdg"><stop offset="0" stop-color="#ff3b4a" stop-opacity=".8"/><stop offset="1" stop-color="#ff3b4a" stop-opacity="0"/></radialGradient><linearGradient id="lid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d6e3f2"/></linearGradient>
<radialGradient id="shd"><stop offset="0" stop-color="#010510" stop-opacity=".85"/><stop offset=".55" stop-color="#010510" stop-opacity=".35"/><stop offset="1" stop-color="#010510" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r=".8" fill="#CDEBFF"/></pattern>
<filter id="air1" x="-260" y="-260" width="520" height="520" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.007 0.011" numOctaves="2" seed="4"><animate attributeName="baseFrequency" dur="36s" repeatCount="indefinite" values="0.007 0.011;0.010 0.007;0.007 0.011"/></feTurbulence><feColorMatrix values="0 0 0 0 .86  0 0 0 0 .96  0 0 0 0 1  0 0 0 2.6 -1.0"/><feGaussianBlur stdDeviation="2"/></filter>
<filter id="air2" x="-260" y="-260" width="520" height="520" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.009 0.006" numOctaves="2" seed="11"><animate attributeName="baseFrequency" dur="44s" repeatCount="indefinite" values="0.009 0.006;0.006 0.010;0.009 0.006"/></feTurbulence><feColorMatrix values="0 0 0 0 .13  0 0 0 0 .45  0 0 0 0 1  0 0 0 2.6 -.95"/><feGaussianBlur stdDeviation="2"/></filter>
<filter id="air3" x="-260" y="-260" width="520" height="520" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.016 0.02" numOctaves="2" seed="7"><animate attributeName="baseFrequency" dur="28s" repeatCount="indefinite" values="0.016 0.02;0.022 0.014;0.016 0.02"/></feTurbulence><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 2.2 -1.0"/><feGaussianBlur stdDeviation="1.5"/></filter>
<filter id="skin" color-interpolation-filters="sRGB" x="-25%" y="-25%" width="150%" height="150%"><feTurbulence id="tb" type="fractalNoise" baseFrequency="0.011 0.013" numOctaves="1" seed="3" result="n"/><feOffset id="fo" in="n" dx="0" dy="0" result="o"/><feDisplacementMap id="dm" in="SourceGraphic" in2="o" scale="0" xChannelSelector="R" yChannelSelector="G"/></filter>
<filter id="wsoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.3"/></filter><filter id="air4" x="-260" y="-260" width="520" height="520" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="21" result="w"><animate attributeName="baseFrequency" dur="50s" repeatCount="indefinite" values="0.008 0.012;0.012 0.008;0.008 0.012"/></feTurbulence><feTurbulence type="fractalNoise" baseFrequency="0.013 0.02" numOctaves="5" seed="30" result="n"/><feDisplacementMap in="n" in2="w" scale="95" xChannelSelector="R" yChannelSelector="G"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 3.4 -1.65"/><feGaussianBlur stdDeviation="1.1"/></filter><filter id="air5" x="-260" y="-260" width="520" height="520" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.011 0.009" numOctaves="2" seed="33" result="w"><animate attributeName="baseFrequency" dur="36s" repeatCount="indefinite" values="0.011 0.009;0.008 0.013;0.011 0.009"/></feTurbulence><feTurbulence type="fractalNoise" baseFrequency="0.026 0.034" numOctaves="5" seed="42" result="n"/><feDisplacementMap in="n" in2="w" scale="60" xChannelSelector="R" yChannelSelector="G"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 3.4 -1.65"/><feGaussianBlur stdDeviation="1.1"/></filter><clipPath id="clip"><circle r="148"/></clipPath>
<g id="ob">
<circle r="150" fill="url(#body)"/>
<circle id="dotsc" r="148" fill="url(#dots)" opacity=".2"/>
<g clip-path="url(#clip)">
<rect x="-260" y="-260" width="520" height="520" filter="url(#air2)" opacity=".6"><animateTransform attributeName="transform" type="translate" values="0 0;70 -26;0 0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="41s" repeatCount="indefinite"/></rect>
<rect x="-260" y="-260" width="520" height="520" filter="url(#air1)" opacity=".8"><animateTransform attributeName="transform" type="translate" values="0 0;-80 30;0 0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="34s" repeatCount="indefinite"/></rect>
<rect x="-260" y="-260" width="520" height="520" filter="url(#air3)" opacity=".5"><animateTransform attributeName="transform" type="translate" values="0 0;-50 -60;0 0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="23s" repeatCount="indefinite"/></rect>
<g id="wind"><rect x="-260" y="-260" width="520" height="520" filter="url(#air4)" opacity="0.75"><animateTransform attributeName="transform" type="translate" values="0 0;-60 22;0 0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="47s" repeatCount="indefinite"/></rect><rect x="-260" y="-260" width="520" height="520" filter="url(#air5)" opacity="0.45"><animateTransform attributeName="transform" type="translate" values="0 0;50 -34;0 0" keyTimes="0;.5;1" calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1" dur="31s" repeatCount="indefinite"/></rect></g></g>
<g id="mer" clip-path="url(#clip)" fill="none" stroke="#DFF4FF" stroke-width=".9" opacity="0"></g>
<circle id="tint" r="150" fill="#4FB4FF" fill-opacity="0"/>
<circle id="bright" r="150" fill="url(#brg)" fill-opacity="0"/>
<circle id="dim" r="150" fill="#050B1A" fill-opacity="0"/>
<g id="core" opacity="0"><circle id="cg" r="60" fill="url(#cgr)"/><circle id="o1" r="24" fill="url(#cgr)"/><circle id="o2" r="18" fill="url(#cgr)"/><circle id="rw" r="20" fill="none" stroke="#a8e6ff" stroke-width="1.6" opacity="0"/></g>
<circle r="150" fill="url(#deep)"/>
<circle r="150" fill="url(#under)"/>
<ellipse cx="-52" cy="-92" rx="44" ry="22" transform="rotate(-28 -52 -92)" fill="url(#hl)"/>
<circle cx="-92" cy="-52" r="5" fill="#fff" opacity=".55"/>
<circle r="149" fill="none" stroke="#D6F5FF" stroke-opacity=".6" stroke-width="2.5"/></g><g id="shb"><circle r="150" fill="url(#shg)"/><circle r="148" fill="url(#dots)" opacity=".28"/><ellipse cx="-52" cy="-92" rx="48" ry="24" transform="rotate(-28 -52 -92)" fill="url(#hl)"/><circle r="148.5" fill="none" stroke="#d6f5ff" stroke-opacity=".75" stroke-width="2.5"/></g></defs>
<g transform="translate(200 196)">
<ellipse id="shadow" cx="0" cy="170" rx="112" ry="15" fill="url(#shd)" opacity=".7"/>
<g id="float"><g id="shake">
<circle id="halo" r="198" fill="url(#halo-g)" pointer-events="none"/>
<circle id="rg1" r="150" fill="none" stroke="#5CF0A0" stroke-width="3" stroke-opacity="0" pointer-events="none"/>
<circle id="rg2" r="150" fill="none" stroke="#5CF0A0" stroke-width="2" stroke-opacity="0" pointer-events="none"/>
<g id="gl" opacity="0" pointer-events="none"><rect class="gr" x="150" y="0" width="30" height="3" fill="#FF4A55"/><rect class="gr" x="150" y="0" width="30" height="3" fill="#FF4A55"/><rect class="gr" x="150" y="0" width="30" height="3" fill="#FF4A55"/><rect class="gr" x="150" y="0" width="30" height="3" fill="#FF4A55"/><rect class="gr" x="150" y="0" width="30" height="3" fill="#FF4A55"/></g>
<circle id="crk" r="125" fill="url(#rdg)" opacity="0"/>
<g id="orb"><circle r="150" fill="transparent"/><g id="acB"></g><use id="whole" href="#ob"/><circle id="tn" r="150" fill="url(#tng)" opacity="0"/><circle id="sh3" r="150" fill="url(#d3)" opacity="0"/><circle id="rl3" r="150" fill="url(#r3)" opacity="0"/><g id="spec" pointer-events="none"><ellipse rx="28" ry="10" fill="url(#hl)"/><ellipse rx="11" ry="3.4" fill="#fff" opacity=".75"/></g><g id="shards"></g><g id="shell"></g><g id="acF"></g>
<g id="e3" opacity="0" filter="url(#gw)"><g id="e3L"><ellipse cy="4" rx="21" ry="31" fill="#061a45" opacity=".2"/><ellipse rx="15" ry="24" style="fill:var(--c4)"/><ellipse cx="-3" cy="-9" rx="4" ry="8" fill="#fff" opacity=".6"/></g><g id="e3R"><ellipse cy="4" rx="21" ry="31" fill="#061a45" opacity=".2"/><ellipse rx="15" ry="24" style="fill:var(--c4)"/><ellipse cx="-3" cy="-9" rx="4" ry="8" fill="#fff" opacity=".6"/></g></g>
<g id="eyes"><g id="pz" opacity="0" filter="url(#gw)"></g>
<path id="lidL" d="M-45 -49Q-31 -57 -17 -49" stroke="#E4FCFF" stroke-width="4" stroke-linecap="round" opacity="0"/><path id="lidR" d="M17 -49Q31 -57 45 -49" stroke="#E4FCFF" stroke-width="4" stroke-linecap="round" opacity="0"/>
<g id="eL"><ellipse cx="-31" cy="-12" rx="33" ry="43" fill="url(#eg)"/><g id="capL"><rect x="-42.5" y="-35" width="23" height="46" rx="11.5" fill="url(#ey)"/><ellipse cx="-36.5" cy="-23" rx="3.3" ry="7.5" fill="#fff"/><circle cx="-30" cy="3" r="2.2" fill="#fff" opacity=".7"/></g><path id="arcL" d="M-43 -4Q-31 -28 -19 -4" fill="none" stroke="#E4FCFF" stroke-width="11" stroke-linecap="round" opacity="0"/></g>
<g id="eR"><ellipse cx="31" cy="-12" rx="33" ry="43" fill="url(#eg)"/><g id="capR"><rect x="19.5" y="-35" width="23" height="46" rx="11.5" fill="url(#ey)"/><ellipse cx="25.5" cy="-23" rx="3.3" ry="7.5" fill="#fff"/><circle cx="32" cy="3" r="2.2" fill="#fff" opacity=".7"/></g><path id="arcR" d="M19 -4Q31 -28 43 -4" fill="none" stroke="#E4FCFF" stroke-width="11" stroke-linecap="round" opacity="0"/></g>
</g>
<g id="gls" opacity="0" fill="none" stroke="#10285a" stroke-width="6" stroke-linecap="round"><circle cx="-48" cy="-2" r="46" fill="#cfeeff" fill-opacity=".14"/><circle cx="48" cy="-2" r="46" fill="#cfeeff" fill-opacity=".14"/><path d="M-3 -8Q0 -13 3 -8M-93 -12L-141 -24M93 -12L141 -24"/><path d="M-78 -26Q-68 -40 -52 -42M18 -26Q28 -40 44 -42" stroke="#fff" stroke-width="4" opacity=".7"/></g>
<g id="wb" opacity="0"><rect x="-176" y="-148" width="94" height="28" rx="14" fill="#3f9cff" stroke="#bfe3ff" stroke-width="1.5"/><text x="-146" y="-129" font-size="13" font-weight="600" fill="#fff" text-anchor="middle" font-family="system-ui,sans-serif">Working</text><circle cx="-104" cy="-134" r="2.4" fill="#fff"><animate attributeName="opacity" values=".25;1;.25" dur="1.2s" begin="0.0s" repeatCount="indefinite"/></circle><circle cx="-97" cy="-134" r="2.4" fill="#fff"><animate attributeName="opacity" values=".25;1;.25" dur="1.2s" begin="0.2s" repeatCount="indefinite"/></circle><circle cx="-90" cy="-134" r="2.4" fill="#fff"><animate attributeName="opacity" values=".25;1;.25" dur="1.2s" begin="0.4s" repeatCount="indefinite"/></circle></g>
<g id="hnd" opacity="0" fill="#fff" stroke="#bfe3ff" stroke-width="2.5"><circle id="hL" r="10" cx="-154" cy="78"/><circle id="hR" r="10" cx="154" cy="78"/></g>
</g>
<g id="lap" opacity="0">
<rect x="-100" y="66" width="200" height="92" rx="12" fill="url(#lid)" stroke="#c9d8ea" stroke-width="2"/>
<circle cy="112" r="16" fill="url(#hl)"/><circle cy="112" r="5" fill="#bfe3ff"/>
<path d="M-120 158H120Q120 173 102 173H-102Q-120 173 -120 158Z" fill="#dce6f3" stroke="#c9d8ea" stroke-width="2"/>
<circle cx="-60" cy="62" r="14" fill="#fff" stroke="#bfe3ff" stroke-width="2.5"><animateTransform attributeName="transform" type="translate" values="0 0;0 7;0 0" dur=".45s" repeatCount="indefinite"/></circle><circle cx="60" cy="62" r="14" fill="#fff" stroke="#bfe3ff" stroke-width="2.5"><animateTransform attributeName="transform" type="translate" values="0 0;0 7;0 0" dur=".45s" begin="-.22s" repeatCount="indefinite"/></circle></g>
<g id="bk" opacity="0"><animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur="3s" repeatCount="indefinite" additive="sum"/>
<path d="M-70 176H78Q78 186 68 186H-68Q-78 186 -78 176Z" fill="#fff6e0" stroke="#d8c9a0" stroke-width="2"/>
<rect x="-78" y="76" width="156" height="104" rx="9" fill="url(#bkg)"/><rect x="-78" y="76" width="14" height="104" rx="7" fill="#000" opacity=".22"/>
<circle cx="8" cy="112" r="15" fill="none" stroke="#ffe08a" stroke-width="3.5"/><path d="M-34 148H50M-20 160H36" stroke="#ffe08a" stroke-width="4" stroke-linecap="round"/>
<circle cx="-86" cy="152" r="14" fill="#fff" stroke="#bfe3ff" stroke-width="2.5"/><circle cx="86" cy="152" r="14" fill="#fff" stroke="#bfe3ff" stroke-width="2.5"/></g>
</g></g></g></svg>`,
 ghost: '<img class="glyph glyph-kai glyph-ghost" src="assets/kai-avatar-mark.png" alt="" aria-hidden="true">',
};
})();
